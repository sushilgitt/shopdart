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
import { repairEmptyVariantTags } from "../lib/tagging.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // Shop-wide sweep for tags cached without variants — see
  // repairEmptyVariantTags. A no-op once healed, so it costs nothing to leave
  // on the page a merchant lands on most often.
  await repairEmptyVariantTags(admin, shop.id);

  const videos = await prisma.video.findMany({
    where: { shopId: shop.id, archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { _count: { select: { tags: true } } },
  });

  return {
    videos: videos.map((video) => ({
      id: video.id,
      title: video.title ?? "Untitled",
      source: video.source,
      status: video.status as string,
      durationSec: video.durationSec,
      posterUrl: video.posterUrl,
      errorMessage: video.errorMessage,
      tagCount: video._count.tags,
    })),
    used: await countActiveVideos(shop.id),
    limit: planFor(shop.plan).videos,
    instagramConnected: Boolean(shop.igUserId),
    igUsername: shop.igUsername,
    bunnyReady: isBunnyConfigured(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Upload credentials are issued by the /api/upload resource route, not here:
  // this route renders a document, so it cannot answer with JSON.
  if (intent === "archive") {
    await archiveVideo(shop.id, String(form.get("videoId")));
    return { ok: true as const };
  }

  return { ok: false as const, error: "Unknown action" };
};

interface UploadState {
  name: string;
  percent: number;
  error?: string;
}

export default function Videos() {
  const { videos, used, limit, instagramConnected, igUsername, bunnyReady } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const atLimit = used >= limit;
  const uploadsDisabled = atLimit || !bunnyReady;

  // Shown on the drop zone itself, so the reason sits next to the control the
  // merchant just found unresponsive rather than only in a panel further down.
  const blockedReason = !bunnyReady
    ? "Video hosting isn't connected yet."
    : atLimit
      ? `You've used all ${limit.toLocaleString()} videos on your plan.`
      : null;

  const handleFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);

      for (const file of files) {
        const key = `${file.name}-${file.lastModified}`;
        setUploads((prev) => ({
          ...prev,
          [key]: { name: file.name, percent: 0 },
        }));

        // Ask our server for a Bunny slot plus signed upload credentials.
        // Posted to the resource route rather than this page: a POST to a page
        // route is a document request and answers with HTML, not JSON.
        const body = new FormData();
        body.set("fileName", file.name);
        const response = await fetch("/api/upload", {
          method: "POST",
          body,
        });
        const data = await response.json();

        if (!data.ok) {
          setUploads((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          setNotice(data.error ?? "Could not start the upload.");
          return;
        }

        // tus-js-client is browser-only — imported lazily so it never lands in
        // the server bundle.
        const tus = await import("tus-js-client");

        await new Promise<void>((resolve) => {
          const upload = new tus.Upload(file, {
            endpoint: data.upload.endpoint,
            retryDelays: [0, 3000, 5000, 10000, 20000],
            // These must match the values the signature was built from, byte
            // for byte, or Bunny answers 401.
            headers: {
              AuthorizationSignature: data.upload.signature,
              AuthorizationExpire: String(data.upload.expire),
              VideoId: data.upload.videoId,
              LibraryId: data.upload.libraryId,
            },
            metadata: {
              filetype: file.type || "video/mp4",
              title: file.name,
            },
            onProgress: (sent: number, total: number) => {
              const percent = Math.round((sent / total) * 100);
              setUploads((prev) => ({
                ...prev,
                [key]: { ...prev[key], percent },
              }));
            },
            onSuccess: () => {
              setUploads((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
              resolve();
            },
            onError: (error: Error) => {
              setUploads((prev) => ({
                ...prev,
                [key]: { ...prev[key], error: error.message },
              }));
              resolve();
            },
          });
          upload.start();
        });
      }

      revalidator.revalidate();
    },
    [revalidator],
  );

  const inFlight = Object.values(uploads);

  return (
    <s-page heading="Videos">
      {!bunnyReady && (
        <s-section heading="Video hosting isn't connected yet">
          <s-paragraph>
            Shopdart streams video through Bunny Stream. Add your library ID, API
            key and CDN hostname before uploading.
          </s-paragraph>
        </s-section>
      )}

      {/*
        The upload control has to live in the page body, not in the title bar.

        `slot="primary-action"` on s-page does not render a button inside the
        app frame — it configures the Shopify admin's own title bar, which is a
        different document. App Bridge relays the press back in as a synthetic
        event, and a synthetic event carries no transient user activation. That
        is fatal for exactly one thing: opening a file picker. `input.click()`
        is specified to return silently without activation, so the old header
        button fired its handler, opened nothing, and reported no error.

        s-drop-zone sits in the frame, so its click is a real user gesture. It
        also accepts drag-and-drop, which the hidden input never could.
      */}
      <s-section heading="Upload video">
        <s-paragraph>
          <s-text color="subdued">
            Drop video files here, or click to choose them. Files upload straight
            from your browser to Bunny Stream, so they never pass through
            Shopdart and large uploads resume if the connection drops.
          </s-text>
        </s-paragraph>
        <s-drop-zone
          label="Video files"
          labelAccessibilityVisibility="exclusive"
          accessibilityLabel="Drop video files here, or click to choose them"
          accept="video/*"
          multiple
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
          {...(uploadsDisabled ? { disabled: true } : {})}
          {...(blockedReason ? { error: blockedReason } : {})}
        />
      </s-section>

      {notice && (
        <s-section heading="Upload didn't start">
          <s-paragraph>{notice}</s-paragraph>
        </s-section>
      )}

      {inFlight.length > 0 && (
        <s-section heading="Uploading">
          <s-stack direction="block" gap="small-200">
            {inFlight.map((upload) => (
              <s-box
                key={upload.name}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{upload.name}</s-text>
                  <s-text color="subdued">
                    {upload.error
                      ? `Failed: ${upload.error}`
                      : `${upload.percent}% uploaded`}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {videos.length === 0 && inFlight.length === 0 && (
        <s-section heading="No videos yet">
          <s-paragraph>
            Upload an MP4 from your computer, or connect Instagram to bring in
            reels from your own account. Videos are encoded and streamed through
            Bunny Stream so playback stays fast anywhere in the world.
          </s-paragraph>
        </s-section>
      )}

      {videos.length > 0 && (
        <s-section
          heading={`${videos.length} video${videos.length === 1 ? "" : "s"}`}
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
                        {video.durationSec
                          ? ` · ${formatDuration(video.durationSec)}`
                          : ""}
                        {` · ${video.tagCount} product${video.tagCount === 1 ? "" : "s"} tagged`}
                      </s-text>
                      {video.errorMessage && (
                        <s-text color="subdued">{video.errorMessage}</s-text>
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

      <s-section slot="aside" heading="Library usage">
        <s-paragraph>
          <s-text type="strong">{used}</s-text>
          <s-text color="subdued"> of {limit.toLocaleString()} videos</s-text>
        </s-paragraph>
        {atLimit && (
          <s-paragraph>
            <s-text color="subdued">
              Remove a video or upgrade your plan to add more.
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Instagram">
        {instagramConnected ? (
          <s-paragraph>
            Connected as <s-text type="strong">@{igUsername}</s-text>
          </s-paragraph>
        ) : (
          <>
            <s-paragraph>
              Connect your Instagram Business or Creator account to sync your own
              reels.
            </s-paragraph>
            <s-button href="/app/instagram" variant="secondary">
              Connect Instagram
            </s-button>
          </>
        )}
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

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
