/**
 * TikTok — provenance, not ingest.
 *
 * There is deliberately no download here, and there cannot be. No tier of
 * TikTok's API returns a video file: the Display API answers with metadata and
 * an embed (`embed_link`, `cover_image_url`, `share_url`) and nothing else,
 * which is a stated content-protection decision on their side rather than a
 * gap we could route around. The unofficial scrapers that do return a file are
 * the same class of dependency this project already refused for Instagram
 * public links — ongoing breakage, and terms we would be knowingly violating.
 *
 * So a TikTok post reaches Shopdart the one legitimate way it can: the
 * merchant supplies the original file they filmed. This module's whole job is
 * to turn a pasted link into provenance — which post it was, who posted it,
 * what it was called — so the library can show the connection and refuse the
 * same post twice.
 *
 * Everything here is best-effort by design. `parseTikTokUrl` is pure string
 * work and always available. `fetchOEmbed` is a network call to tiktok.com,
 * which is unreachable from a large part of the world — including India, where
 * roughly a third of this market's merchants are. It must therefore never gate
 * an upload: a merchant whose server cannot see TikTok types their own title
 * and loses nothing else.
 */

/** Public oEmbed endpoint. No key, no registration, no app review. */
const OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";

/**
 * Bounds every call to TikTok.
 *
 * A refused connection fails instantly, but a blackholed one hangs until the
 * socket gives up, and this runs inside the request that issues upload
 * credentials. The merchant is waiting on it.
 */
const TIMEOUT_MS = 5000;

export interface TikTokPost {
  /** Numeric post id — the external identity we dedupe on. */
  videoId: string;
  /** Handle without the "@", when the URL carried one. */
  username: string | null;
  /** Canonical permalink, rebuilt rather than echoed back. */
  url: string;
}

/** Post ids are long numeric strings; anything else is not one. */
const POST_ID = /^\d{6,32}$/;

/**
 * Reads a canonical TikTok post URL.
 *
 * Handles the form every "Copy link" on the web produces:
 *   https://www.tiktok.com/@handle/video/7123456789012345678
 *
 * Short links (vm.tiktok.com, vt.tiktok.com, /t/…) carry no post id at all —
 * they are opaque redirects — so they are rejected here rather than guessed
 * at. `resolveShortLink` handles those, separately, because it costs a network
 * round trip and this function must stay usable offline.
 */
export function parseTikTokUrl(input: string): TikTokPost | null {
  const raw = input.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);

  // /@handle/video/{id}  and  /@handle/photo/{id}
  const kind = segments[1]?.toLowerCase();
  if (
    segments[0]?.startsWith("@") &&
    (kind === "video" || kind === "photo") &&
    segments[2]
  ) {
    const videoId = segments[2].split("?")[0];
    if (!POST_ID.test(videoId)) return null;
    const username = segments[0].slice(1) || null;
    return {
      videoId,
      username,
      url: username
        ? `https://www.tiktok.com/@${username}/video/${videoId}`
        : `https://www.tiktok.com/video/${videoId}`,
    };
  }

  return null;
}

/** True for the opaque share links that need a redirect to resolve. */
export function isShortLink(input: string): boolean {
  const raw = input.trim();
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) return false;
    if (/^(vm|vt)\./i.test(url.hostname)) return true;
    return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() === "t";
  } catch {
    return false;
  }
}

/**
 * Expands a share link into a canonical post URL.
 *
 * Follows redirects and reads nothing but the final URL — the response body is
 * a full TikTok page we have no use for. Returns null on any failure,
 * including the common one where TikTok simply is not reachable from this
 * server; the caller then asks the merchant for the full link instead.
 */
export async function resolveShortLink(
  input: string,
): Promise<TikTokPost | null> {
  try {
    const response = await fetch(input.trim(), {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return parseTikTokUrl(response.url);
  } catch {
    return null;
  }
}

/**
 * Turns whatever the merchant pasted into a post, whichever share form it was.
 *
 * Canonical links resolve offline; short links cost one redirect and fail
 * closed when TikTok is unreachable, which the caller reports as "paste the
 * full link" rather than as a broken feature.
 */
export async function resolvePost(input: string): Promise<TikTokPost | null> {
  const direct = parseTikTokUrl(input);
  if (direct) return direct;
  if (isShortLink(input)) return resolveShortLink(input);
  return null;
}

export interface TikTokOEmbed {
  title: string | null;
  authorName: string | null;
  /** Profile URL, so a later ownership check has something to compare. */
  authorUrl: string | null;
  /**
   * TikTok's cover image. Useful only as a placeholder while the merchant's
   * own file encodes — these URLs expire, and Bunny generates the real poster
   * from the uploaded file anyway.
   */
  thumbnailUrl: string | null;
}

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
}

/**
 * Reads the public oEmbed record for a post.
 *
 * Unauthenticated on purpose: this is the one TikTok surface that needs no
 * developer account, no app review and no OAuth, which makes it the only one a
 * merchant — or we — can rely on being able to reach.
 *
 * Returns null rather than throwing. Every caller treats an absent record as
 * "no metadata", never as an error worth showing.
 */
export async function fetchOEmbed(
  postUrl: string,
): Promise<TikTokOEmbed | null> {
  try {
    const endpoint = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(postUrl)}`;
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    // A blocked network often answers with an interstitial page rather than a
    // transport error, so the parse itself has to be treated as fallible.
    const data = (await response.json()) as OEmbedResponse;

    return {
      title: clean(data.title),
      authorName: clean(data.author_name),
      authorUrl: clean(data.author_url),
      thumbnailUrl: clean(data.thumbnail_url),
    };
  } catch {
    return null;
  }
}

/**
 * Turns a caption into a library title.
 *
 * TikTok's oEmbed `title` is the full caption, hashtags and all, which makes a
 * poor row label. Matches the trimming `instagram-sync.server.ts` already
 * applies to reel captions so the two libraries read alike.
 */
export function titleFromCaption(caption?: string | null): string {
  if (!caption) return "";
  const firstLine = caption.split("\n")[0].trim();
  return firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
}

function clean(value?: string | null): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}
