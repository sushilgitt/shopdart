import type { ActionFunctionArgs } from "react-router";
import { parseSignedRequest } from "../lib/instagram.server";
import { disconnectInstagram } from "../lib/instagram-sync.server";
import prisma from "../db.server";

/**
 * Meta deauthorize callback: POST /instagram/deauthorize
 *
 * Fired when someone removes Shopdart from their Instagram account rather than
 * disconnecting inside our admin. Without this the stored token silently rots:
 * every sync fails, the merchant is told their connection "expired", and we
 * keep a credential we are no longer entitled to hold.
 *
 * Registering this URL is also a prerequisite for taking the Meta app out of
 * Development mode, so no real merchant can connect until it exists.
 *
 * Public and unauthenticated by necessity — Meta calls it server to server
 * with no session. The signed_request signature is the only authentication,
 * which is why an unverifiable body is rejected rather than best-guessed.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let signedRequest: string;
  try {
    const form = await request.formData();
    signedRequest = String(form.get("signed_request") ?? "");
  } catch {
    return new Response("Malformed request", { status: 400 });
  }

  if (!signedRequest) {
    return new Response("Missing signed_request", { status: 400 });
  }

  let payload;
  try {
    payload = parseSignedRequest(signedRequest);
  } catch (error) {
    // Instagram not configured at all — nothing to deauthorize against.
    console.error("Deauthorize callback could not verify signed_request", error);
    return new Response("Not configured", { status: 503 });
  }

  if (!payload) {
    return new Response("Invalid signature", { status: 401 });
  }

  // One Instagram account may be connected to several stores.
  const shops = await prisma.shop.findMany({
    where: { igUserId: payload.user_id },
    select: { id: true, domain: true },
  });

  for (const shop of shops) {
    await disconnectInstagram(shop.id);
    console.log(`Instagram deauthorized for ${shop.domain}`);
  }

  // Acknowledge even when nothing matched, so Meta stops retrying.
  return new Response("OK", { status: 200 });
};

export const loader = () => new Response("Method not allowed", { status: 405 });
