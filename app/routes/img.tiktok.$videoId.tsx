import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { fetchOEmbed } from "../lib/tiktok.server";

/**
 * TikTok cover proxy: GET /img/tiktok/{videoId}
 *
 * TikTok's cover URLs cannot be given to shoppers directly, for two
 * independent reasons:
 *
 *  - They are served from tiktokcdn hosts, which are unreachable in every
 *    country that blocks TikTok. The image simply fails to load, and a
 *    shoppable video collapses to a black rectangle — which is worse than the
 *    embed failing, because the poster is what the fallback relies on.
 *  - They are signed and carry an `x-expires`. Whatever we cached at import
 *    time stops working within weeks, for everyone.
 *
 * Serving them from our own origin fixes both. This server can reach TikTok —
 * proving account ownership depends on it — so it fetches the cover on the
 * shopper's behalf, and re-reads oEmbed for a fresh signed URL when the stored
 * one has expired.
 *
 * There is no SSRF surface here despite the outbound fetch: the URL is never
 * supplied by the caller. It comes from a Video row we own, keyed on an id, and
 * is checked against TikTok's own CDN hosts before a request is made.
 */

/** Only TikTok's own image CDNs. Anything else is not a cover we published. */
const ALLOWED_HOST = /(^|\.)(tiktokcdn|tiktokcdn-eu|tiktokcdn-us|ibyteimg)\.com$/i;

/** Covers are tens of kilobytes; anything far larger is not one. */
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 6000;

function allowed(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function load(url: string): Promise<Response | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "image/*" },
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    return response;
  } catch {
    return null;
  }
}

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const videoId = String(params.videoId ?? "");
  if (!/^[a-z0-9]{20,40}$/i.test(videoId)) {
    return new Response("Not found", { status: 404 });
  }

  const video = await prisma.video.findFirst({
    where: { id: videoId, source: "TIKTOK" },
    select: { id: true, posterUrl: true, sourceUrl: true },
  });
  if (!video) return new Response("Not found", { status: 404 });

  let upstream = allowed(video.posterUrl) ? await load(video.posterUrl!) : null;

  // The stored URL has expired, or was never usable. oEmbed hands back a
  // freshly signed one, which is also worth persisting so the next shopper
  // does not pay for this round trip.
  if (!upstream && video.sourceUrl) {
    const meta = await fetchOEmbed(video.sourceUrl);
    if (allowed(meta?.thumbnailUrl ?? null)) {
      upstream = await load(meta!.thumbnailUrl!);
      if (upstream) {
        await prisma.video
          .update({
            where: { id: video.id },
            data: { posterUrl: meta!.thumbnailUrl },
          })
          // A failed write only costs the next request another refresh.
          .catch(() => undefined);
      }
    }
  }

  if (!upstream) {
    // No cover available. 404 rather than a placeholder image: the player
    // already has a fallback for a poster that will not load, and inventing a
    // picture here would hide the problem from it.
    return new Response("No cover available", {
      status: 404,
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }

  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    return new Response("Cover too large", { status: 502 });
  }

  return new Response(buffer, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      // Long-lived on purpose: the bytes for a given post never change, and
      // this is the request every shopper makes before anything else renders.
      // stale-while-revalidate keeps a refresh off the critical path.
      "Cache-Control":
        "public, max-age=86400, stale-while-revalidate=604800, stale-if-error=604800",
      "Access-Control-Allow-Origin": "*",
      "Timing-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      Vary: "Accept-Encoding",
    },
  });
};
