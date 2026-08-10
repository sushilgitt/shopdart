import type { ActionFunctionArgs } from "react-router";
import { ingestEvents, type IncomingEvent } from "../lib/events.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Guards against a malformed or hostile beacon flooding the batch. */
const MAX_EVENTS = 50;

/**
 * Storefront event beacon: POST /api/events
 *
 * Called with `navigator.sendBeacon` from the theme extension and with
 * `fetch(keepalive)` from the web pixel, so nothing waits on the response and
 * the handler must never block the shopper. It always answers 204 — a beacon
 * has no error path, and returning failures would only encourage retries that
 * double-count.
 *
 * The body is read as text rather than with `request.json()` because callers
 * send it as `text/plain`. That is deliberate: `text/plain` is CORS-safelisted,
 * so these cross-origin posts stay "simple" requests and skip the preflight.
 * A preflight could not be answered anyway — React Router dispatches only GET
 * and the mutation methods, so an OPTIONS request never reaches this route and
 * comes back as a bare 405, which fails CORS and makes the browser discard the
 * beacon before it is sent.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  try {
    // Tolerates any content type, so a caller sending application/json still
    // works — it just pays for a preflight it does not need.
    const body = JSON.parse(await request.text()) as {
      shop?: string;
      events?: IncomingEvent[];
    };

    const shop = String(body.shop ?? "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      return new Response(null, { status: 204, headers: CORS });
    }

    const events = Array.isArray(body.events)
      ? body.events.slice(0, MAX_EVENTS)
      : [];
    if (events.length === 0) {
      return new Response(null, { status: 204, headers: CORS });
    }

    await ingestEvents(shop, events, request.headers.get("User-Agent"));
  } catch (error) {
    // Swallow deliberately. A shopper's page must never surface an analytics
    // failure, and sendBeacon discards the response anyway.
    console.error("Event ingest failed", error);
  }

  return new Response(null, { status: 204, headers: CORS });
};

export const loader = () =>
  new Response("Method not allowed", { status: 405, headers: CORS });
