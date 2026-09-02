import { createHmac } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { instagramConfig, parseSignedRequest } from "../lib/instagram.server";
import { deleteInstagramData } from "../lib/instagram-sync.server";

/**
 * Meta data deletion callback: POST /instagram/data-deletion
 *
 * Required before the Meta app can leave Development mode, alongside the
 * deauthorize callback.
 *
 * Deletion here is wider than a disconnect. The imported reels are copies of
 * the requester's own content, so honouring the request means removing them
 * too — not just dropping the token. `deleteInstagramData` archives the rows
 * (so historical analytics still resolve) and deletes the Bunny assets, which
 * is where the video actually lives.
 *
 * Meta expects a JSON body of `{ url, confirmation_code }`, where `url` is a
 * human-readable page reporting the status of that request.
 */

/**
 * Deterministic per-account code, derived from the app secret.
 *
 * Deliberately not random: we complete deletion synchronously before
 * responding, so there is no pending state to persist and therefore no need
 * for a request table. Deriving the code means the status page can recognise a
 * code we actually issued instead of echoing back whatever it is handed.
 */
function confirmationCode(userId: string, appSecret: string): string {
  return createHmac("sha256", appSecret)
    .update(`data-deletion:${userId}`)
    .digest("hex")
    .slice(0, 16);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let config;
  try {
    config = instagramConfig();
  } catch {
    return new Response("Not configured", { status: 503 });
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

  const payload = parseSignedRequest(signedRequest, config);
  if (!payload) {
    return new Response("Invalid signature", { status: 401 });
  }

  const code = confirmationCode(payload.user_id, config.appSecret);

  try {
    const removed = await deleteInstagramData(payload.user_id);
    console.log(
      `Instagram data deletion ${code}: ${removed.shops} shop(s), ${removed.videos} video(s)`,
    );
  } catch (error) {
    // 500 so Meta retries — a dropped deletion request is a compliance failure,
    // not a cosmetic one.
    console.error(`Instagram data deletion ${code} failed`, error);
    return new Response("Deletion failed", { status: 500 });
  }

  const origin = new URL(request.url).origin;

  return Response.json({
    url: `${origin}/instagram/data-deletion?code=${code}`,
    confirmation_code: code,
  });
};

/**
 * Status page for a deletion request. Meta requires the URL above to be
 * reachable and to describe the request's state.
 *
 * A resource route rather than a rendered component: this is shown to someone
 * outside the Shopify admin, so it should not pull in the app shell.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  const known = /^[a-f0-9]{16}$/.test(code);

  const body = known
    ? `<h1>Deletion complete</h1>
       <p>Request <code>${code}</code> has been processed. The Instagram
       connection and every reel imported from it have been removed from
       DPS.</p>`
    : `<h1>Unknown request</h1>
       <p>No deletion request matches that code.</p>`;

  return new Response(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>DPS — data deletion</title>
     <main style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:72px 24px;line-height:1.6">
       ${body}
     </main>`,
    {
      status: known ? 200 : 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
};
