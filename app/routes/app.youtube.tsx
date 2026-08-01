import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { isYouTubeConfigured, YouTubeQuotaError } from "../lib/youtube.server";
import {
  YouTubeNotConnectedError,
  type BrowsableYouTubeVideo,
  browseUploads,
  connectChannel,
  disconnectYouTube,
  importVideos,
} from "../lib/youtube-sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const pageToken = url.searchParams.get("pageToken") ?? undefined;
  const shortsOnly = url.searchParams.get("all") !== "1";

  const configured = isYouTubeConfigured();
  const connected = Boolean(shop.ytChannelId && shop.ytUploadsPlaylistId);

  if (!configured || !connected) {
    return {
      configured,
      connected: false as const,
      channelTitle: null,
      shortsOnly,
      videos: [] as BrowsableYouTubeVideo[],
      nextPageToken: null as string | null,
      loadError: null as string | null,
    };
  }

  let videos: BrowsableYouTubeVideo[] = [];
  let nextPageToken: string | null = null;
  let loadError: string | null = null;

  try {
    const page = await browseUploads(shop, { pageToken, shortsOnly });
    videos = page.videos;
    nextPageToken = page.nextPageToken;
  } catch (error) {
    if (error instanceof YouTubeQuotaError) {
      loadError = error.message;
    } else if (error instanceof YouTubeNotConnectedError) {
      loadError = "No channel is connected.";
    } else {
      console.error("browseUploads failed", error);
      loadError = "Could not load videos from YouTube.";
    }
  }

  return {
    configured,
    connected: true as const,
    channelTitle: shop.ytChannelTitle,
    shortsOnly,
    videos,
    nextPageToken,
    loadError,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "connect") {
    const input = String(form.get("channel") ?? "").trim();
    if (!input) {
      return { ok: false as const, error: "Enter your channel handle." };
    }
    try {
      const channel = await connectChannel(shop, input);
      if (!channel) {
        return {
          ok: false as const,
          error:
            "Couldn't find that channel. Use your @handle, e.g. @yourbrand, or the full channel URL.",
        };
      }
      return { ok: true as const, connected: channel.title };
    } catch (error) {
      if (error instanceof YouTubeQuotaError) {
        return { ok: false as const, error: error.message };
      }
      console.error("connectChannel failed", error);
      return { ok: false as const, error: "Could not reach YouTube." };
    }
  }

  if (intent === "disconnect") {
    await disconnectYouTube(shop.id);
    return { ok: true as const, disconnected: true };
  }

  if (intent === "import") {
    const ids = form.getAll("videoId").map(String).filter(Boolean);
    if (ids.length === 0) {
      return { ok: false as const, error: "Select at least one video." };
    }
    try {
      const result = await importVideos(shop, ids);
      return { ok: true as const, result };
    } catch (error) {
      if (error instanceof YouTubeQuotaError) {
        return { ok: false as const, error: error.message };
      }
      console.error("importVideos failed", error);
      return { ok: false as const, error: "Import failed. Please try again." };
    }
  }

  return { ok: false as const, error: "Unknown action" };
};

export default function YouTube() {
  const {
    configured,
    connected,
    channelTitle,
    shortsOnly,
    videos,
    nextPageToken,
    loadError,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const busy = fetcher.state !== "idle";
  const importable = videos.filter((video) => !video.imported);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const result =
    fetcher.data?.ok && "result" in fetcher.data ? fetcher.data.result : null;
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  return (
    <s-page heading="YouTube">
      {connected && (
        <s-button
          slot="primary-action"
          onClick={() => {
            const body = new FormData();
            body.set("intent", "import");
            selected.forEach((id) => body.append("videoId", id));
            fetcher.submit(body, { method: "POST" });
            setSelected(new Set());
          }}
          {...(selected.size === 0 || busy ? { disabled: true } : {})}
        >
          {selected.size > 0
            ? `Import ${selected.size} video${selected.size === 1 ? "" : "s"}`
            : "Import selected"}
        </s-button>
      )}

      {!configured && (
        <s-section heading="YouTube isn't set up yet">
          <s-paragraph>
            Shopdart needs a YouTube Data API key before channels can be
            connected. Add YOUTUBE_API_KEY.
          </s-paragraph>
        </s-section>
      )}

      {configured && !connected && (
        <s-section heading="Connect your YouTube channel">
          <s-paragraph>
            Enter the handle of a channel you own. Shopdart reads its public
            uploads — it never posts, comments or changes anything.
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              Videos play in YouTube&rsquo;s own player, so your tagged products
              appear beside the video rather than inside it.
            </s-text>
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="connect" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="channel"
                label="Channel handle"
                placeholder="@yourbrand"
              />
              <s-button type="submit" {...(busy ? { loading: true } : {})}>
                Connect channel
              </s-button>
            </s-stack>
          </fetcher.Form>
        </s-section>
      )}

      {error && (
        <s-section heading="Something went wrong">
          <s-paragraph>{error}</s-paragraph>
        </s-section>
      )}

      {result && (
        <s-section heading="Import finished">
          <s-paragraph>
            {result.imported} imported
            {result.skipped > 0 ? `, ${result.skipped} already in your library` : ""}
            {result.failed > 0 ? `, ${result.failed} failed` : ""}.
          </s-paragraph>
          {result.errors.map((message) => (
            <s-paragraph key={message}>
              <s-text color="subdued">{message}</s-text>
            </s-paragraph>
          ))}
        </s-section>
      )}

      {connected && loadError && (
        <s-section heading="Couldn't load your videos">
          <s-paragraph>{loadError}</s-paragraph>
        </s-section>
      )}

      {connected && !loadError && (
        <s-section
          heading={
            videos.length > 0
              ? `${videos.length} video${videos.length === 1 ? "" : "s"}`
              : "No videos found"
          }
        >
          <s-paragraph>
            <s-text color="subdued">
              {shortsOnly
                ? "Showing Shorts only — vertical clips suit the widget layouts."
                : "Showing every public upload."}
            </s-text>{" "}
            <s-link href={shortsOnly ? "/app/youtube?all=1" : "/app/youtube"}>
              {shortsOnly ? "Show all videos" : "Show Shorts only"}
            </s-link>
          </s-paragraph>

          {videos.length === 0 ? (
            <s-paragraph>
              Nothing to import here. Videos with embedding disabled are hidden,
              because they cannot play on a storefront.
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="small-200">
              {videos.map((video) => (
                <s-box
                  key={video.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background={video.imported ? "subdued" : undefined}
                >
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {video.thumbnailUrl && (
                        <img
                          src={video.thumbnailUrl}
                          alt=""
                          width={64}
                          height={48}
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
                          {video.durationSec !== null
                            ? formatDuration(video.durationSec)
                            : "—"}
                          {video.isShort ? " · Short" : ""}
                          {video.imported ? " · Already imported" : ""}
                        </s-text>
                      </s-stack>
                    </s-stack>

                    {!video.imported && (
                      <s-button
                        variant="secondary"
                        onClick={() => toggle(video.id)}
                      >
                        {selected.has(video.id) ? "Selected" : "Select"}
                      </s-button>
                    )}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}

          {nextPageToken && (
            <s-paragraph>
              <s-link
                href={`/app/youtube?pageToken=${encodeURIComponent(nextPageToken)}${shortsOnly ? "" : "&all=1"}`}
              >
                Load more videos
              </s-link>
            </s-paragraph>
          )}
        </s-section>
      )}

      {connected && (
        <s-section slot="aside" heading="Channel">
          <s-paragraph>
            <s-text type="strong">{channelTitle}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              {importable.length} video{importable.length === 1 ? "" : "s"} on
              this page not yet imported.
            </s-text>
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <s-button type="submit" variant="tertiary">
              Disconnect channel
            </s-button>
          </fetcher.Form>
        </s-section>
      )}

      <s-section slot="aside" heading="How YouTube differs">
        <s-paragraph>
          <s-text color="subdued">
            YouTube does not allow their videos to be re-hosted, so these play
            in YouTube&rsquo;s embedded player. Product tagging, analytics and
            add-to-cart all work — the product card sits beside the video rather
            than over it.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
