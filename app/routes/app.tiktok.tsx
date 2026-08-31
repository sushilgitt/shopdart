import { useCallback, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { planFor } from "../lib/plans";
import { isBunnyConfigured } from "../lib/bunny.server";
import { archiveVideo, countActiveVideos } from "../lib/video.server";
import { startUpload } from "../lib/upload-client";

/**
 * TikTok.
 *
 * Structurally unlike the Instagram and YouTube pages, and it has to be. Those
 * browse a connected account and import in one click, because both platforms
 * hand back something importable — a file in Instagram's case, an embeddable
 * id in YouTube's.
 *
 * TikTok hands back neither. No tier of their API returns a video file, and
 * that is a deliberate content-protection decision rather than a gap to route
 * around. The honest options were an iframe embed, which renders blank in
 * every country where TikTok is blocked — including one holding roughly a
 * third of this market's merchants — or the merchant's own file. This page is
 * the second: it collects the link for provenance and the original file for
 * playback, and what comes out is an ordinary hosted video with full autoplay
 * and in-player checkout.
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

  if (String(form.get("intent")) === "archive") {
    await archiveVideo(shop.id, String(form.get("videoId")));
    return { ok: true as const };
  }

  return { ok: false as const, error: "Unknown action" };
};

export default function TikTok() {
  const { videos, used, limit, bunnyReady } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const [link, setLink] = useState("");
  const [owned, setOwned] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const atLimit = used >= limit;

  // Shown on the drop zone itself, so the reason sits next to the control the
  // merchant just found unresponsive rather than only in a panel further down.
  const blocked = !bunnyReady
    ? "Video hosting isn't connected yet."
    : atLimit
      ? `You've used all ${limit.toLocaleString()} videos on your plan.`
      : !owned
        ? "Confirm the video is yours before uploading."
        : null;

  const handleFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);
      const file = files[0];
      if (!file) return;

      setProgress(0);
      const result = await startUpload(
        { file, sourceUrl: link.trim() || undefined },
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

      <s-section heading="Add a TikTok video">
        <s-paragraph>
          <s-text color="subdued">
            TikTok doesn&rsquo;t let apps download videos, so Shopdart uses the
            file you already have. Paste the link to your post so the video
            stays connected to it, then drop in the video file itself.
          </s-text>
        </s-paragraph>

        <s-text-field
          label="TikTok post link (optional)"
          placeholder="https://www.tiktok.com/@yourname/video/1234567890"
          value={link}
          onChange={(event) => setLink(event.currentTarget.value)}
        />

        <s-checkbox
          label="This video is mine, or I have permission to use it"
          checked={owned}
          onChange={(event) => setOwned(event.currentTarget.checked)}
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

      {notice && (
        <s-section heading="Upload didn't start">
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
                    <s-button
                      href={`/app/videos/${video.id}`}
                      variant="secondary"
                    >
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
