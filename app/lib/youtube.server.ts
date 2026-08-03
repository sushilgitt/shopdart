/**
 * YouTube Data API v3 client.
 *
 * Read-only over a server-side API key against public channel data.
 *
 * Ownership is NOT established here — this module can read any public channel
 * and has no notion of who is asking. Proving that a channel belongs to the
 * merchant is done once, via OAuth, in youtube-oauth.server.ts, and every
 * caller in youtube-sync.server.ts is gated on that having happened. There is
 * deliberately no "resolve a channel by handle" function: it would be an
 * obvious way to attach a channel without passing the gate.
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
  uploadsPlaylistId: string;
  thumbnailUrl: string | null;
  /** The About text. Carries the verification code during a claim. */
  description: string;
}

interface ChannelsResponse {
  items?: {
    id: string;
    snippet?: {
      title?: string;
      description?: string;
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
    };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }[];
}

/**
 * Normalises whatever the merchant pasted into something channels.list accepts.
 *
 * Legacy `/c/CustomName` and `/user/Name` URLs are deliberately unsupported:
 * resolving those needs search.list at 100 units a call, and the modern
 * @handle appears on every channel page anyway.
 */
function parseChannelInput(raw: string): { handle?: string; id?: string } | null {
  const input = raw.trim();
  if (!input) return null;

  if (/^UC[\w-]{20,}$/.test(input)) return { id: input };

  if (/^@?[\w.-]{3,30}$/.test(input) && !input.includes("/")) {
    return { handle: input.startsWith("@") ? input : `@${input}` };
  }

  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0]?.startsWith("@")) return { handle: segments[0] };
    if (segments[0] === "channel" && segments[1]) return { id: segments[1] };
    return null;
  } catch {
    return null;
  }
}

/**
 * Looks up a public channel.
 *
 * Resolving a channel is NOT the same as owning it — anyone can look up
 * anyone. Callers must treat the result as an unverified claim until either
 * Google confirms ownership via OAuth, or the verification code is found in
 * the description. See youtube-sync.server.ts, where that gate lives.
 */
export async function resolveChannel(
  input: string,
  config?: YouTubeConfig,
): Promise<YouTubeChannel | null> {
  const parsed = parseChannelInput(input);
  if (!parsed) return null;

  return fetchChannel(
    parsed.id ? { id: parsed.id } : { forHandle: parsed.handle! },
    config,
  );
}

/** Re-reads a channel by id — used to check the description during a claim. */
export async function fetchChannelById(
  channelId: string,
  config?: YouTubeConfig,
): Promise<YouTubeChannel | null> {
  return fetchChannel({ id: channelId }, config);
}

async function fetchChannel(
  selector: Record<string, string>,
  config?: YouTubeConfig,
): Promise<YouTubeChannel | null> {
  const data = await ytFetch<ChannelsResponse>(
    "channels",
    { part: "snippet,contentDetails", ...selector },
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
    description: item.snippet?.description ?? "",
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
  /**
   * False when the creator disabled embedding. Such a video renders "Video
   * unavailable" in the iframe player, so it must never reach a storefront.
   */
  embeddable: boolean;
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
    status?: { embeddable?: boolean; privacyStatus?: string };
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

  // `status` matters as much as `contentDetails`: a creator can disable
  // embedding on any video, including their own, and importing one renders
  // "Video unavailable" on the storefront with nothing surfaced in the admin.
  const details = await ytFetch<VideosResponse>(
    "videos",
    { part: "contentDetails,status", id: ids.join(",") },
    cfg,
  );
  const durations = new Map(
    (details.items ?? []).map((item) => [
      item.id,
      parseIsoDuration(item.contentDetails?.duration),
    ]),
  );
  const embeddable = new Map(
    (details.items ?? []).map((item) => [
      item.id,
      // Absent means embeddable — only an explicit false disables it.
      item.status?.embeddable !== false,
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
      embeddable: embeddable.get(id) !== false,
    };
  });

  return { videos, nextPageToken: page.nextPageToken ?? null };
}

interface VideosDetailResponse {
  items?: {
    id: string;
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      thumbnails?: Record<string, { url?: string } | undefined>;
    };
    contentDetails?: { duration?: string };
    status?: { embeddable?: boolean };
  }[];
}

/**
 * Reads specific videos by id — one quota unit per 50, whatever the channel's
 * size.
 *
 * Importing must never page through the uploads playlist hunting for the
 * chosen ids: that costs two units per page and scales with how far down the
 * channel the selection sits. Asking for exactly the ids wanted is a fixed,
 * trivial cost, and quota is the binding constraint on this integration.
 */
export async function fetchVideosByIds(
  ids: string[],
  config?: YouTubeConfig,
): Promise<Map<string, YouTubeVideo>> {
  const found = new Map<string, YouTubeVideo>();
  if (ids.length === 0) return found;

  const cfg = config ?? youtubeConfig();

  // videos.list accepts at most 50 ids per call.
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);

    const data = await ytFetch<VideosDetailResponse>(
      "videos",
      { part: "snippet,contentDetails,status", id: batch.join(",") },
      cfg,
    );

    for (const item of data.items ?? []) {
      const durationSec = parseIsoDuration(item.contentDetails?.duration);
      found.set(item.id, {
        id: item.id,
        title: item.snippet?.title ?? "",
        description: item.snippet?.description ?? null,
        publishedAt: item.snippet?.publishedAt ?? null,
        thumbnailUrl: bestThumbnail(item.snippet?.thumbnails),
        durationSec,
        isShort: durationSec !== null && durationSec <= SHORTS_MAX_SECONDS,
        embeddable: item.status?.embeddable !== false,
      });
    }
  }

  return found;
}

/** Canonical watch URL, stored so the admin can link back to the original. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
