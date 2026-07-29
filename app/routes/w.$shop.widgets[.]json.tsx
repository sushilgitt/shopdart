import type { LoaderFunctionArgs } from "react-router";
import { buildStorefrontPayload } from "../lib/storefront-payload.server";

/**
 * Public widget payload for a storefront: GET /w/{shop}/widgets.json
 *
 * Deliberately not behind an app proxy. A proxy round-trips through Shopify
 * and caches poorly; this URL is a plain cacheable document that a CDN pull
 * zone can sit in front of without any code change.
 *
 * Caching is the whole design here:
 *  - `max-age=60` so a merchant's edit appears within a minute.
 *  - `stale-while-revalidate=86400` so shoppers are served instantly from
 *    cache while it refreshes in the background, and — importantly — keep
 *    being served if our origin is down. A storefront should not lose its
 *    video section because Shopdart is having a bad day.
 *
 * Metafields were the alternative and are wrong here: they are cached in
 * Liquid for hours, so a merchant changing a colour would not see it until the
 * next day.
 */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const shopDomain = String(params.shop ?? "").toLowerCase();

  // Reject anything that isn't a myshopify domain before it reaches the
  // database — this endpoint is unauthenticated and internet-facing.
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return new Response("Invalid shop", { status: 400 });
  }

  const payload = await buildStorefrontPayload(shopDomain);

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control":
      "public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400",
    // Storefronts are on the merchant's own domain, so this is cross-origin by
    // definition. The document is public and contains no shopper data.
    "Access-Control-Allow-Origin": "*",
    "Timing-Allow-Origin": "*",
    Vary: "Accept-Encoding",
  };

  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }

  return new Response(JSON.stringify(payload), { headers });
};

/** Preflight, in case a theme adds custom headers to the fetch. */
export const action = () =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
