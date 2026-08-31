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

  const [link, setLink] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const atLimit = used >= limit;

  // The link is required, not optional. It is the only thing that ties an
  // uploaded file to a post we can check the ownership of — without it there
  // is nothing to verify against, and this page would be an ordinary upload
  // form wearing a TikTok heading.
  const blocked = !bunnyReady
    ? "Video hosting isn't connected yet."
    : !verified
      ? "Verify your TikTok account before adding videos."
      : atLimit
        ? `You've used all ${limit.toLocaleString()} videos on your plan.`
        : !link.trim()
          ? "Paste the link to your TikTok post first."
          : null;

  const handleFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);
      const file = files[0];
      if (!file) return;

      setProgress(0);
      const result = await startUpload(
        { file, sourceUrl: link.trim() },
        { onProgress: setProgress },
      );
      setProgress(null);

      if (!result.ok) {
        setNotice(result.error);
        return;
      }

      // The link described the video that just went up, not the next one.
      setLink("");
      revalidator.revalidate();
    },
    [link, revalidator],
  );

  return (
    <s-page heading="TikTok">
      {!bunnyReady && (
        <s-section heading="Video hosting isn't connected yet">
          <s-paragraph>
            Shopdart streams video through Bunny Stream. Add your library ID,
            API key and CDN hostname before uploading.
          </s-paragraph>
        </s-section>
      )}

      {!username && (
        <s-section heading="Connect your TikTok account">
          <s-paragraph>
            <s-text color="subdued">
              Shopdart only accepts videos from an account you have proven is
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
        <s-section heading="Add a video from your TikTok">
          <s-paragraph>
            <s-text color="subdued">
              TikTok doesn&rsquo;t let apps download videos, so Shopdart uses
              the file you already have. Paste the link to your post, then drop
              in the video file. Shopdart checks with TikTok that the post is
              yours before accepting it.
            </s-text>
          </s-paragraph>

          <s-text-field
            label="TikTok post link"
            placeholder="https://www.tiktok.com/@yourname/video/1234567890"
            value={link}
            onChange={(event) => setLink(event.currentTarget.value)}
          />

          <s-drop-zone
            label="Video file"
            labelAccessibilityVisibility="exclusive"
            accessibilityLabel="Drop your TikTok video file here, or click to choose it"
            accept="video/*"
            onChange={(event) => {
              // Snapshot before resetting: clearing `value` is what lets a
              // merchant re-pick the same file after a failed attempt, and the
              // file list is emptied by that reset.
              const zone = event.currentTarget;
              const picked = Array.from(zone.files ?? []);
              zone.value = "";
              if (picked.length > 0) void handleFiles(picked);
            }}
            onDropRejected={() =>
              setNotice("That file isn't a video Shopdart can upload.")
            }
            {...(blocked ? { disabled: true, error: blocked } : {})}
          />

          {progress !== null && (
            <s-paragraph>
              <s-text color="subdued">{progress}% uploaded</s-text>
            </s-paragraph>
          )}
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
                        {` · ${video.tagCount} product${video.tagCount === 1 ? "" : "s"} tagged`}
                      </s-text>
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
                    <s-button href={`/app/videos/${video.id}`} variant="secondary">
                      {video.tagCount > 0 ? "Edit tags" : "Tag products"}
                    </s-button>
                    <Form method="post">
                      <input type="hidden" name="intent" value="archive" />
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

      <s-section slot="aside" heading="Finding your video file">
        <s-paragraph>
          <s-text color="subdued">
            The best copy is the original you edited before posting — no
            watermark, full quality.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            If you no longer have it, open the post in the TikTok app, tap
            Share, then Save to device. That copy carries a TikTok watermark.
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
