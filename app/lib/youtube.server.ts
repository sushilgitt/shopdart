/**
 * YouTube Data API v3 client.
 *
 * Read-only over a server-side API key against public channels. Deliberately
 * not OAuth: listing a merchant's own uploads needs no user consent, which
 * avoids Google's verification review and any per-merchant token to store,
 * encrypt or refresh. OAuth only becomes necessary for private or unlisted
 * videos, which merchants would not put on a storefront anyway.
 *
 * QUOTA IS THE BINDING CONSTRAINT. The default allowance is 10,000 units per
 * day for the whole app, across every merchant — not per shop. Costs:
 *
 *   search.list         100 units   <- never use it to list a channel
 *   channels.list         1 unit
 *   playlistItems.list    1 unit    (per page of up to 50)
 *   videos.list           1 unit    (per page of up to 50)
 *
 * Listing uploads via search.list would cap the entire app at ~100 browses a
 * day. Resolving the channel once, caching its uploads playlist, and paging
 * that instead costs 1 unit per 50 videos.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

/** YouTube's own limit for Shorts. Used to separate them from long-form. */
export const SHORTS_MAX_SECONDS = 180;

export interface YouTubeConfig {
  apiKey: string;
}

export function youtubeConfig(): YouTubeConfig {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YouTube is not configured. Set YOUTUBE_API_KEY.");
  }
  return { apiKey };
}

/** True when a key is present, so the UI can degrade rather than throw. */
export function isYouTubeConfigured(): boolean {
  return Boolean(
    process.env.YOUTUBE_API_KEY &&
      !process.env.YOUTUBE_API_KEY.startsWith("CHANGEME"),
  );
}

export class YouTubeQuotaError extends Error {
  constructor() {
    super("The daily YouTube API quota has been used up. Try again tomorrow.");
    this.name = "YouTubeQuotaError";
  }
}

async function ytFetch<T>(
  path: string,
  params: Record<string, string>,
  config?: YouTubeConfig,
): Promise<T> {
  const cfg = config ?? youtubeConfig();
  const query = new URLSearchParams({ ...params, key: cfg.apiKey });

  const response = await fetch(`${API_BASE}/${path}?${query.toString()}`);

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    // Quota exhaustion is a 403 with reason quotaExceeded. Worth its own error
    // type: it is temporary and self-healing, and telling a merchant to "try
    // again tomorrow" is very different from telling them something broke.
    if (response.status === 403 && body.includes("quotaExceeded")) {
      throw new YouTubeQuotaError();
    }

    throw new Error(
      `YouTube ${path} failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface YouTubeChannel {
  id: string;
  title: string;
  /** The auto-generated playlist holding every public upload. */
  uploadsPlaylistId: string;
  thumbnailUrl: string | null;
}

interface ChannelsResponse {
  items?: {
    id: string;
    snippet?: {
      title?: string;
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
    };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }[];
}

/**
 * Normalises whatever the merchant pasted into something channels.list accepts.
 *
 * Legacy `/c/CustomName` and `/user/Name` URLs are deliberately not handled:
 * resolving those requires search.list at 100 units a go, and the modern
 * @handle is shown on every channel page anyway.
 */
function parseChannelInput(raw: string): { handle?: string; id?: string } | null {
  const input = raw.trim();
  if (!input) return null;

  // Bare channel id.
  if (/^UC[\w-]{20,}$/.test(input)) return { id: input };

  // Bare handle, with or without the @.
  if (/^@?[\w.-]{3,30}$/.test(input) && !input.includes("/")) {
    return { handle: input.startsWith("@") ? input : `@${input}` };
  }

  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;

    const handleSegment = url.pathname.split("/").filter(Boolean);
    if (handleSegment[0]?.startsWith("@")) return { handle: handleSegment[0] };
    if (handleSegment[0] === "channel" && handleSegment[1]) {
      return { id: handleSegment[1] };
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveChannel(
  input: string,
  config?: YouTubeConfig,
): Promise<YouTubeChannel | null> {
  const parsed = parseChannelInput(input);
  if (!parsed) return null;

  const data = await ytFetch<ChannelsResponse>(
    "channels",
    {
      part: "snippet,contentDetails",
      ...(parsed.id ? { id: parsed.id } : { forHandle: parsed.handle! }),
    },
    config,
  );

  const item = data.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!item || !uploads) return null;

  return {
    id: item.id,
    title: item.snippet?.title ?? "",
    uploadsPlaylistId: uploads,
    thumbnailUrl:
      item.snippet?.thumbnails?.medium?.url ??
      item.snippet?.thumbnails?.default?.url ??
      null,
  };
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  /** Null when videos.list did not return a parseable duration. */
  durationSec: number | null;
  /** Duration-based, because the API exposes no aspect ratio. Approximate. */
  isShort: boolean;
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items?: {
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
      thumbnails?: Record<string, { url?: string } | undefined>;
    };
  }[];
}

interface VideosResponse {
  items?: {
    id: string;
    contentDetails?: { duration?: string };
  }[];
}

/**
 * Parses an ISO 8601 duration such as `PT1M45S` into seconds.
 *
 * Only hours, minutes and seconds appear on videos; the day and week
 * components of the spec cannot occur here.
 */
export function parseIsoDuration(value?: string): number | null {
  if (!value) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return null;

  const [, hours, minutes, seconds] = match;
  if (!hours && !minutes && !seconds) return null;

  return (
    Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  );
}

function bestThumbnail(
  thumbnails?: Record<string, { url?: string } | undefined>,
): string | null {
  if (!thumbnails) return null;
  // Descending quality. `maxres` is absent on plenty of videos, so fall back
  // rather than rendering a broken poster.
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    const url = thumbnails[key]?.url;
    if (url) return url;
  }
  return null;
}

/**
 * Lists one page of a channel's uploads, newest first, with durations resolved.
 *
 * Costs 2 quota units per call: one playlistItems.list plus one videos.list for
 * the durations, which playlistItems does not carry.
 */
export async function fetchUploads(
  uploadsPlaylistId: string,
  options: { pageToken?: string; limit?: number } = {},
  config?: YouTubeConfig,
): Promise<{ videos: YouTubeVideo[]; nextPageToken: string | null }> {
  const cfg = config ?? youtubeConfig();
  const limit = Math.min(options.limit ?? 50, 50);

  const page = await ytFetch<PlaylistItemsResponse>(
    "playlistItems",
    {
      part: "snippet",
      playlistId: uploadsPlaylistId,
      maxResults: String(limit),
      ...(options.pageToken ? { pageToken: options.pageToken } : {}),
    },
    cfg,
  );

  const items = (page.items ?? []).filter(
    (item) => item.snippet?.resourceId?.videoId,
  );
  if (items.length === 0) {
    return { videos: [], nextPageToken: page.nextPageToken ?? null };
  }

  const ids = items.map((item) => item.snippet!.resourceId!.videoId!);

  const details = await ytFetch<VideosResponse>(
    "videos",
    { part: "contentDetails", id: ids.join(",") },
    cfg,
  );
  const durations = new Map(
    (details.items ?? []).map((item) => [
      item.id,
      parseIsoDuration(item.contentDetails?.duration),
    ]),
  );

  const videos: YouTubeVideo[] = items.map((item) => {
    const snippet = item.snippet!;
    const id = snippet.resourceId!.videoId!;
    const durationSec = durations.get(id) ?? null;

    return {
      id,
      title: snippet.title ?? "",
      description: snippet.description ?? null,
      publishedAt: snippet.publishedAt ?? null,
      thumbnailUrl: bestThumbnail(snippet.thumbnails),
      durationSec,
      isShort: durationSec !== null && durationSec <= SHORTS_MAX_SECONDS,
    };
  });

  return { videos, nextPageToken: page.nextPageToken ?? null };
}

/** Canonical watch URL, stored so the admin can link back to the original. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
