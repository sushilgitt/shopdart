import { useCallback, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { planFor } from "../lib/plans";
import { isBunnyConfigured } from "../lib/bunny.server";
import { archiveVideo, countActiveVideos } from "../lib/video.server";
import { startUpload } from "../lib/upload-client";
import {
  TikTokUnreachableError,
  beginAccountClaim,
  disconnectTikTok,
  stagePosts,
  unstagePost,
  verifyAccountByCaption,
  verificationCodeFor,
} from "../lib/tiktok-sync.server";

/**
 * TikTok.
 *
 * Two things make this page unlike Instagram and YouTube.
 *
 * First, nothing is imported. No tier of TikTok's API returns a video file, so
 * the merchant supplies the original they filmed and it travels the ordinary
 * upload path into Bunny. What comes out plays with full autoplay and
 * in-player checkout, and does not go blank in the countries where TikTok is
 * blocked.
 *
 * Second, ownership has to be proven rather than assumed. Instagram's token is
 * scoped to the merchant's own media and YouTube answers `mine=true`; TikTok
 * offers neither without a developer app. So the merchant publishes a derived
 * code in the caption of one of their own posts, and oEmbed reads it back —
 * the same trust model as a DNS TXT record. Until that passes, this page will
 * not accept a video.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const videos = await prisma.video.findMany({
    where: { shopId: shop.id, source: "TIKTOK", archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { _count: { select: { tags: true } } },
  });

  return {
    username: shop.ttUsername,
    verified: Boolean(shop.ttVerifiedAt),
    // Only meaningful while a claim is pending, and only ever shown to the
    // merchant who owns the shop it is derived from.
    code:
      shop.ttUsername && !shop.ttVerifiedAt
        ? verificationCodeFor(shop.id, shop.ttUsername)
        : null,
    videos: videos.map((video) => ({
      id: video.id,
      title: video.title ?? "Untitled",
      status: video.status as string,
      // Whether we hold the file. Embeds play through TikTok's player and can
      // be upgraded by supplying the original; hosted videos are already the
      // better tier and have a Bunny asset to release when removed.
      hosted: Boolean(video.bunnyVideoId),
      posterUrl: video.posterUrl,
      sourceUrl: video.sourceUrl,
      errorMessage: video.errorMessage,
      tagCount: video._count.tags,
    })),
    used: await countActiveVideos(shop.id),
    limit: planFor(shop.plan).videos,
    bunnyReady: isBunnyConfigured(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "claim") {
    const claim = await beginAccountClaim(shop, String(form.get("username") ?? ""));
    if (!claim) {
      return {
        ok: false as const,
        error: "That doesn't look like a TikTok username. Enter it like @yourname.",
      };
    }
    return { ok: true as const, message: `Now add the code to a post on @${claim.username}.` };
  }

  if (intent === "verify") {
    try {
      const result = await verifyAccountByCaption(shop, String(form.get("postUrl") ?? ""));
      return result.ok
        ? { ok: true as const, message: "TikTok account verified." }
        : { ok: false as const, error: result.reason };
    } catch (error) {
      if (error instanceof TikTokUnreachableError) {
        return { ok: false as const, error: error.message };
      }
      console.error("TikTok verification failed", error);
      return { ok: false as const, error: "Could not check that post. Try again." };
    }
  }

  if (intent === "disconnect") {
    await disconnectTikTok(shop.id);
    return { ok: true as const, message: "TikTok account disconnected." };
  }

  if (intent === "stage") {
    const result = await stagePosts(shop, String(form.get("links") ?? ""));
    if (result.added === 0) {
      return {
        ok: false as const,
        error: result.errors[0] ?? "No posts were added.",
      };
    }
    const parts = [`Added ${result.added} post${result.added === 1 ? "" : "s"}`];
    if (result.skipped) parts.push(`${result.skipped} already in your library`);
    if (result.failed) parts.push(`${result.failed} couldn't be added`);
    return { ok: true as const, message: `${parts.join(" · ")}.` };
  }

  if (intent === "unstage") {
    await unstagePost(shop.id, String(form.get("videoId")));
    return { ok: true as const, message: "Post removed." };
  }

  if (intent === "archive") {
    await archiveVideo(shop.id, String(form.get("videoId")));
    return { ok: true as const, message: "Video removed." };
  }

  return { ok: false as const, error: "Unknown action" };
};

export default function TikTok() {
  const { username, verified, code, videos, used, limit, bunnyReady } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  // Every action on this page — claiming, verifying, disconnecting, removing —
  // returns to a page that can look identical to the one before it. Verifying
  // in particular fails for several distinct reasons, and the merchant has to
  // be told which one.
  useEffect(() => {
    if (!actionData) return;
    if (actionData.ok) {
      shopify.toast.show(actionData.message ?? "Saved");
    } else {
      shopify.toast.show(actionData.error ?? "That didn't work", {
        isError: true,
      });
    }
  }, [actionData, shopify]);

  // Which staged row is currently receiving a file, and how far along it is.
  // Per row rather than per page, because the drop zones sit inside the rows.
  const [uploading, setUploading] = useState<{
    id: string;
    percent: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const atLimit = used >= limit;
  // Videos with no file of our own. They depend on TikTok being reachable from
  // wherever the shopper is, which is worth saying out loud rather than
  // letting a merchant discover it from a support ticket.
  const embedOnly = videos.filter((video) => !video.hosted).length;

  // Why a file cannot be accepted right now, shown on the drop zone itself so
  // the reason sits beside the control the merchant just found unresponsive.
  const blocked = !bunnyReady
    ? "Video hosting isn't connected yet."
    : atLimit
      ? `You've used all ${limit.toLocaleString()} videos on your plan.`
      : null;

  /**
   * Attaches a file to one staged post.
   *
   * The post's own link travels with the upload, so the server re-checks
   * ownership against TikTok before it accepts the file — the same gate the
   * post passed when it was staged. It is repeated deliberately: this endpoint
   * is reachable directly, and a check that only ran at staging time would be
   * one a caller could skip.
   */
  const attachFile = useCallback(
    async (videoId: string, sourceUrl: string, files: File[]) => {
      setNotice(null);
      const file = files[0];
      if (!file) return;

      setUploading({ id: videoId, percent: 0 });
      const result = await startUpload(
        { file, sourceUrl },
        {
          onProgress: (percent) => setUploading({ id: videoId, percent }),
        },
      );
      setUploading(null);

      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      revalidator.revalidate();
    },
    [revalidator],
  );

  return (
    <s-page heading="TikTok">
      {!bunnyReady && (
        <s-section heading="Video hosting isn't connected yet">
          <s-paragraph>
            DPS streams video through Bunny Stream. Add your library ID,
            API key and CDN hostname before uploading.
          </s-paragraph>
        </s-section>
      )}

      {!username && (
        <s-section heading="Connect your TikTok account">
          <s-paragraph>
            <s-text color="subdued">
              DPS only accepts videos from an account you have proven is
              yours. Enter your username to start.
            </s-text>
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="claim" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="username"
                label="TikTok username"
                placeholder="@yourname"
              />
              <s-button type="submit">Continue</s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      {username && !verified && code && (
        <s-section heading={`Verify that @${username} is yours`}>
          <s-paragraph>
            Add this code to the caption of any one of your TikTok posts. Only
            someone signed in to the account can do that, which is what proves
            it belongs to you. You can remove the code once verified.
          </s-paragraph>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text type="strong">{code}</s-text>
          </s-box>
          <s-paragraph>
            <s-text color="subdued">
              Then paste that post&rsquo;s link below. TikTok can take a minute
              to publish a caption edit.
            </s-text>
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="verify" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="postUrl"
                label="Link to the post containing the code"
                placeholder="https://www.tiktok.com/@yourname/video/1234567890"
              />
              <s-button type="submit">Verify account</s-button>
            </s-stack>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <s-button type="submit" variant="tertiary">
              Use a different account
            </s-button>
          </Form>
        </s-section>
      )}

      {verified && (
        <s-section heading="Add your TikTok posts">
          <s-paragraph>
            <s-text color="subdued">
              Paste the links to your TikTok posts — one per line, up to 25 at a
              time. DPS checks each one belongs to @{username}, then adds
              it below ready to tag and publish.
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              Add each video&rsquo;s file afterwards. That is what makes it
              autoplay as shoppers scroll and play in every country. Without
              one it falls back to TikTok&rsquo;s player, which shows nothing
              where TikTok is blocked.
            </s-text>
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="stage" />
            <s-stack direction="block" gap="base">
              <s-text-area
                name="links"
                label="TikTok post links"
                placeholder={`https://www.tiktok.com/@${username}/video/1234567890`}
                rows={4}
              />
              <s-button type="submit">Add posts</s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      {notice && (
        <s-section heading="That video wasn't added">
          <s-paragraph>{notice}</s-paragraph>
        </s-section>
      )}

      {videos.length === 0 ? (
        <s-section heading="No TikTok videos yet">
          <s-paragraph>
            Once you add one it appears here and in your main video library,
            ready to tag products and drop into a widget.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section
          heading={`${videos.length} TikTok video${videos.length === 1 ? "" : "s"}`}
        >
          {embedOnly > 0 && (
            <s-banner tone="warning" heading="Some videos won't play everywhere">
              <s-paragraph>
                {embedOnly === 1 ? "One video plays" : `${embedOnly} videos play`}{" "}
                through TikTok&rsquo;s own player. Shoppers in countries where
                TikTok is blocked — India among them — see the cover image and
                your product card, and can still buy, but the video will not
                play for them.
              </s-paragraph>
              <s-paragraph>
                Uploading your own file on a video fixes that: it plays
                everywhere, and it autoplays as shoppers scroll.
              </s-paragraph>
            </s-banner>
          )}
          <s-stack direction="block" gap="small-200">
            {videos.map((video) => (
              <s-box
                key={video.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    {video.posterUrl && (
                      <img
                        src={video.posterUrl}
                        alt=""
                        width={48}
                        height={64}
                        style={{
                          objectFit: "cover",
                          borderRadius: 4,
                          display: "block",
                        }}
                      />
                    )}
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">{video.title}</s-text>
                      <s-text color="subdued">
                        {statusLabel(video.status)}
                        {video.hosted ? "" : " · needs TikTok to play"}
                        {` · ${video.tagCount} product${video.tagCount === 1 ? "" : "s"} tagged`}
                      </s-text>
                      {!video.hosted && (
                        <s-text color="subdued">
                          Add this video&rsquo;s file to make it autoplay and
                          play everywhere.
                        </s-text>
                      )}
                      {video.errorMessage && (
                        <s-text color="subdued">{video.errorMessage}</s-text>
                      )}
                      {video.sourceUrl && (
                        <s-link href={video.sourceUrl} target="_blank">
                          View original post
                        </s-link>
                      )}
                    </s-stack>
                  </s-stack>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-button
                      href={`/app/videos/${video.id}`}
                      variant="secondary"
                    >
                      {video.tagCount > 0 ? "Edit tags" : "Tag products"}
                    </s-button>

                    {/*
                      Supplying the original file is an upgrade, not a
                      requirement. It swaps TikTok's player for ours, which
                      autoplays and keeps working where TikTok is blocked, so
                      the control stays available on every embed row.
                    */}
                    {!video.hosted &&
                      (uploading?.id === video.id ? (
                        <s-text color="subdued">
                          {uploading.percent}% uploaded
                        </s-text>
                      ) : (
                        <s-drop-zone
                          label="Add file"
                          accessibilityLabel={`Upload your own file for ${video.title} to replace the TikTok player`}
                          accept="video/*"
                          onChange={(event) => {
                            // Snapshot before resetting: clearing `value` is
                            // what lets a merchant re-pick the same file after
                            // a failed attempt, and the file list is emptied
                            // by that reset.
                            const zone = event.currentTarget;
                            const picked = Array.from(zone.files ?? []);
                            zone.value = "";
                            if (picked.length > 0 && video.sourceUrl) {
                              void attachFile(video.id, video.sourceUrl, picked);
                            }
                          }}
                          onDropRejected={() =>
                            setNotice(
                              "That file isn't a video DPS can upload.",
                            )
                          }
                          {...(blocked ? { disabled: true, error: blocked } : {})}
                        />
                      ))}

                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value={video.hosted ? "archive" : "unstage"}
                      />
                      <input type="hidden" name="videoId" value={video.id} />
                      <s-button type="submit" variant="tertiary">
                        Remove
                      </s-button>
                    </Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {verified && (
        <s-section slot="aside" heading="Account">
          <s-paragraph>
            Verified as <s-text type="strong">@{username}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              Only posts from this account can be added. Videos you have
              already added stay in your library if you disconnect.
            </s-text>
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <s-button type="submit" variant="tertiary">
              Disconnect
            </s-button>
          </Form>
        </s-section>
      )}

      <s-section slot="aside" heading="Getting your video files">
        <s-paragraph>
          <s-text color="subdued">
            A video with its file plays from DPS&rsquo;s own CDN: it
            autoplays as shoppers scroll, and it plays everywhere, including
            countries that block TikTok. This is the setup worth aiming for.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Best is the original you edited before posting — no watermark, full
            quality. Otherwise open the post in the TikTok app, tap Share, then
            Save to device; that copy carries a TikTok watermark.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Drop the file on any video below to switch it over.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Library usage">
        <s-paragraph>
          <s-text type="strong">{used}</s-text>
          <s-text color="subdued"> of {limit.toLocaleString()} videos</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Waiting";
    case "UPLOADING":
      return "Uploading";
    case "PROCESSING":
      return "Processing";
    case "READY":
      return "Ready";
    case "FAILED":
      return "Failed";
    default:
      return "Pending";
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
