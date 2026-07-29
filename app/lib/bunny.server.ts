import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Bunny Stream client.
 *
 * Two enums here look interchangeable and are not:
 *  - `BunnyApiStatus` is what `GET /videos/{id}` returns.
 *  - `BunnyWebhookStatus` is what the webhook posts.
 * They disagree on the same numbers — API 3 means Transcoding, webhook 3 means
 * Finished. Never compare one against the other.
 */

const API_BASE = "https://video.bunnycdn.com";
export const TUS_ENDPOINT = `${API_BASE}/tusupload`;

/** Status values returned by the REST API (`VideoModelStatus`). */
export enum BunnyApiStatus {
  Created = 0,
  Uploaded = 1,
  Processing = 2,
  Transcoding = 3,
  Finished = 4,
  Error = 5,
  UploadFailed = 6,
  JitSegmenting = 7,
  JitPlaylistsCreated = 8,
}

/** Status values delivered by the webhook. Deliberately separate. */
export enum BunnyWebhookStatus {
  Queued = 0,
  Processing = 1,
  Encoding = 2,
  Finished = 3,
  /** One rendition is done — the video is already playable at this point. */
  ResolutionFinished = 4,
  Failed = 5,
  PresignedUploadStarted = 6,
  PresignedUploadFinished = 7,
  PresignedUploadFailed = 8,
  CaptionsGenerated = 9,
  TitleOrDescriptionGenerated = 10,
}

export interface BunnyVideo {
  guid: string;
  title: string;
  status: BunnyApiStatus;
  length: number; // seconds
  width: number;
  height: number;
  storageSize: number;
  framerate: number;
  thumbnailFileName?: string;
  availableResolutions?: string;
}

export interface BunnyConfig {
  libraryId: string;
  apiKey: string;
  cdnHostname: string;
  /** Library Read-Only key — the webhook signing secret. Not the API key. */
  readOnlyKey?: string;
}

export function bunnyConfig(): BunnyConfig {
  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const cdnHostname = process.env.BUNNY_STREAM_CDN_HOSTNAME;

  if (!libraryId || !apiKey || !cdnHostname) {
    throw new Error(
      "Bunny Stream is not configured. Set BUNNY_STREAM_LIBRARY_ID, " +
        "BUNNY_STREAM_API_KEY and BUNNY_STREAM_CDN_HOSTNAME.",
    );
  }

  return {
    libraryId,
    apiKey,
    cdnHostname,
    readOnlyKey: process.env.BUNNY_STREAM_READONLY_KEY,
  };
}

/** True when Bunny credentials are present, so the UI can degrade gracefully. */
export function isBunnyConfigured(): boolean {
  return Boolean(
    process.env.BUNNY_STREAM_LIBRARY_ID &&
      process.env.BUNNY_STREAM_API_KEY &&
      process.env.BUNNY_STREAM_CDN_HOSTNAME &&
      !process.env.BUNNY_STREAM_API_KEY.startsWith("CHANGEME"),
  );
}

async function bunnyFetch<T>(
  path: string,
  init: RequestInit & { config?: BunnyConfig } = {},
): Promise<T> {
  const config = init.config ?? bunnyConfig();
  const response = await fetch(`${API_BASE}/library/${config.libraryId}${path}`, {
    ...init,
    headers: {
      AccessKey: config.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Bunny Stream ${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Allocates a video slot. Returns the GUID the upload will target. */
export async function createBunnyVideo(
  title: string,
  config?: BunnyConfig,
): Promise<BunnyVideo> {
  return bunnyFetch<BunnyVideo>("/videos", {
    method: "POST",
    body: JSON.stringify({ title }),
    config,
  });
}

export async function getBunnyVideo(
  guid: string,
  config?: BunnyConfig,
): Promise<BunnyVideo> {
  return bunnyFetch<BunnyVideo>(`/videos/${guid}`, { config });
}

export async function deleteBunnyVideo(
  guid: string,
  config?: BunnyConfig,
): Promise<void> {
  await bunnyFetch<void>(`/videos/${guid}`, { method: "DELETE", config });
}

/**
 * Pulls a remote file into Bunny server-side. This is how Instagram reels are
 * ingested in phase 3 — the CDN URL from the Graph API is short-lived, so the
 * fetch has to happen promptly after we read it.
 */
export async function fetchBunnyVideoFromUrl(
  guid: string,
  url: string,
  config?: BunnyConfig,
): Promise<void> {
  await bunnyFetch<void>(`/videos/${guid}/fetch`, {
    method: "POST",
    body: JSON.stringify({ url }),
    config,
  });
}

export interface PresignedUpload {
  endpoint: string;
  libraryId: string;
  videoId: string;
  /** UNIX seconds. */
  expire: number;
  signature: string;
}

/**
 * Builds credentials for a direct browser-to-Bunny TUS upload, so video bytes
 * never pass through our server.
 *
 * signature = SHA256(libraryId + apiKey + expire + videoId)
 *
 * The client must send these values back byte-for-byte or Bunny answers 401.
 */
export function presignUpload(
  videoId: string,
  ttlSeconds = 3600,
  config?: BunnyConfig,
): PresignedUpload {
  const cfg = config ?? bunnyConfig();
  const expire = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = createHash("sha256")
    .update(`${cfg.libraryId}${cfg.apiKey}${expire}${videoId}`)
    .digest("hex");

  return {
    endpoint: TUS_ENDPOINT,
    libraryId: cfg.libraryId,
    videoId,
    expire,
    signature,
  };
}

/**
 * Verifies a Bunny webhook against the raw request body.
 *
 * The signing secret is the library's Read-Only API key, not the main API key.
 * Pass the untouched body string — re-serialising parsed JSON changes the bytes
 * and the signature will never match.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  config?: BunnyConfig,
): boolean {
  const cfg = config ?? bunnyConfig();
  if (!cfg.readOnlyKey || !signatureHeader) return false;

  const expected = createHmac("sha256", cfg.readOnlyKey)
    .update(rawBody, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Playback URLs
// ---------------------------------------------------------------------------

export function hlsUrl(guid: string, config?: BunnyConfig): string {
  const cfg = config ?? bunnyConfig();
  return `https://${cfg.cdnHostname}/${guid}/playlist.m3u8`;
}

/**
 * Progressive MP4 rendition. Preferred over HLS for clips under ~60s: faster to
 * first frame and no hls.js payload on the storefront. Requires "MP4 Fallback"
 * to be enabled on the Bunny library.
 */
export function mp4Url(
  guid: string,
  resolution: "240p" | "360p" | "480p" | "720p" | "1080p" = "720p",
  config?: BunnyConfig,
): string {
  const cfg = config ?? bunnyConfig();
  return `https://${cfg.cdnHostname}/${guid}/play_${resolution}.mp4`;
}

export function posterUrl(
  guid: string,
  thumbnailFileName = "thumbnail.jpg",
  config?: BunnyConfig,
): string {
  const cfg = config ?? bunnyConfig();
  return `https://${cfg.cdnHostname}/${guid}/${thumbnailFileName}`;
}

/** Animated hover preview. */
export function previewUrl(guid: string, config?: BunnyConfig): string {
  const cfg = config ?? bunnyConfig();
  return `https://${cfg.cdnHostname}/${guid}/preview.webp`;
}

/**
 * Picks the best MP4 rendition Bunny actually produced. `availableResolutions`
 * comes back as a comma list like "240p,360p,720p"; asking for one that was
 * never encoded returns a 404 to the shopper.
 */
export function bestMp4Resolution(
  availableResolutions?: string,
): "240p" | "360p" | "480p" | "720p" | "1080p" {
  const preferred = ["720p", "480p", "1080p", "360p", "240p"] as const;
  if (!availableResolutions) return "720p";
  const have = availableResolutions.split(",").map((r) => r.trim());
  return preferred.find((r) => have.includes(r)) ?? "720p";
}
