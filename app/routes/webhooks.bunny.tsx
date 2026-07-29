import type { ActionFunctionArgs } from "react-router";
import {
  BunnyWebhookStatus,
  bunnyConfig,
  verifyWebhookSignature,
} from "../lib/bunny.server";
import { applyWebhookStatus } from "../lib/video.server";

interface BunnyWebhookPayload {
  VideoLibraryId: number;
  VideoGuid: string;
  Status: number;
}

/**
 * Bunny Stream transcode callback.
 *
 * Not a Shopify webhook, so `authenticate.webhook` does not apply. Bunny signs
 * the raw body with HMAC-SHA256 keyed on the library's Read-Only API key, so
 * the body is read as text and verified before any parsing — re-serialising
 * parsed JSON changes the bytes and would never match.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();

  let config;
  try {
    config = bunnyConfig();
  } catch {
    console.error("Bunny webhook received but Bunny is not configured");
    return new Response("Not configured", { status: 503 });
  }

  // Refuse unsigned traffic outright. Without this anyone who learns a video
  // GUID could flip videos to READY or FAILED on a merchant's storefront.
  if (!config.readOnlyKey) {
    console.error(
      "BUNNY_STREAM_READONLY_KEY is unset — cannot verify Bunny webhooks",
    );
    return new Response("Not configured", { status: 503 });
  }

  const signature = request.headers.get("X-BunnyStream-Signature");
  if (!verifyWebhookSignature(rawBody, signature, config)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: BunnyWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as BunnyWebhookPayload;
  } catch {
    return new Response("Malformed payload", { status: 400 });
  }

  if (String(payload.VideoLibraryId) !== config.libraryId) {
    // Signed by a key we hold, but for a different library. Ignore rather than
    // error so Bunny does not retry forever.
    return new Response("Ignored", { status: 200 });
  }

  if (!payload.VideoGuid) {
    return new Response("Missing VideoGuid", { status: 400 });
  }

  try {
    const video = await applyWebhookStatus(
      payload.VideoGuid,
      payload.Status as BunnyWebhookStatus,
    );
    if (!video) {
      // Unknown GUID — likely a video deleted on our side. Acknowledge so
      // Bunny stops retrying.
      return new Response("Unknown video", { status: 200 });
    }
  } catch (error) {
    console.error(`Bunny webhook failed for ${payload.VideoGuid}`, error);
    // 500 so Bunny retries a transient failure.
    return new Response("Processing error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
};

/** Bunny only POSTs here; a GET is almost always a misconfigured URL. */
export const loader = () => new Response("Method not allowed", { status: 405 });
