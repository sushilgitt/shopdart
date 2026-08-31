import type { ActionFunctionArgs } from "react-router";
import { VideoSource } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import {
  DuplicateSourceError,
  PlanLimitError,
  beginUpload,
  type UploadOrigin,
} from "../lib/video.server";
import {
  fetchOEmbed,
  isShortLink,
  resolvePost,
  titleFromCaption,
} from "../lib/tiktok.server";

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
  const sourceUrl = String(form.get("sourceUrl") ?? "").trim();

  let origin: UploadOrigin = { title };

  // A TikTok link is optional. When one is given it is resolved before any
  // Bunny asset is allocated, so a typo costs nothing and leaves nothing
  // behind.
  if (sourceUrl) {
    const post = await resolvePost(sourceUrl);
    if (!post) {
      return Response.json({
        ok: false,
        error: isShortLink(sourceUrl)
          ? "Couldn't open that short TikTok link. Open the post on tiktok.com and paste the link from your browser's address bar instead."
          : "That doesn't look like a TikTok post link. It should look like https://www.tiktok.com/@yourname/video/1234567890.",
      });
    }

    // Best effort, and deliberately not awaited on for correctness: oEmbed is
    // a call to tiktok.com, which a large part of the world cannot reach. A
    // merchant whose server is blocked keeps every part of this flow except
    // the automatic title.
    const meta = await fetchOEmbed(post.url);

    origin = {
      source: VideoSource.TIKTOK,
      sourceRef: post.videoId,
      sourceUrl: post.url,
      caption: meta?.title ?? null,
      title: title.trim() || titleFromCaption(meta?.title) || undefined,
    };
  }

  try {
    const { video, upload } = await beginUpload(shop, fileName, origin);
    return Response.json({ ok: true, videoId: video.id, upload });
  } catch (error) {
    if (error instanceof DuplicateSourceError) {
      return Response.json({
        ok: false,
        error:
          "That TikTok post is already in your library. Remove it there first if you want to replace the file.",
      });
    }

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
