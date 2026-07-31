import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { PlanLimitError, beginUpload } from "../lib/video.server";

/**
 * Allocates a Bunny video slot and returns signed TUS upload credentials.
 *
 * A resource route — no default export — so React Router returns this JSON
 * verbatim. The upload flow needs a real JSON body it can read imperatively
 * before handing off to tus-js-client, and a POST to a normal page route
 * answers with a rendered HTML document instead.
 *
 * Called with the browser `fetch` that App Bridge patches inside the embedded
 * admin, which attaches the session token, so `authenticate.admin` resolves
 * the shop exactly as it does for a loader.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const fileName = String(form.get("fileName") ?? "video.mp4");
  const title = String(form.get("title") ?? "");

  try {
    const { video, upload } = await beginUpload(shop, fileName, title);
    return Response.json({ ok: true, videoId: video.id, upload });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return Response.json({
        ok: false,
        error: `You've used all ${error.limit} videos on your plan. Remove one or upgrade to add more.`,
      });
    }

    console.error("beginUpload failed", error);
    const notConfigured =
      error instanceof Error && error.message.includes("not configured");
    return Response.json({
      ok: false,
      error: notConfigured
        ? "Video hosting isn't set up yet. Add your Bunny Stream keys first."
        : "Could not start the upload. Please try again.",
    });
  }
};

/** Only ever POSTed to; a GET here is a misconfiguration. */
export const loader = () =>
  Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
