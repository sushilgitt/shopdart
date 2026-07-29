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
 * Called with `navigator.sendBeacon`, so nothing waits on the response and the
 * handler must never block the shopper. It always answers 204 — a beacon has
 * no error path, and returning failures would only encourage retries that
 * double-count.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  try {
    const body = (await request.json()) as {
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
