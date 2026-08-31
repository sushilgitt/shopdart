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
import { titleFromCaption } from "../lib/tiktok.server";
import {
  TikTokNotConnectedError,
  TikTokNotVerifiedError,
  TikTokOwnershipError,
  TikTokUnreachableError,
  assertOwnedPost,
  captionFor,
  markSynced,
} from "../lib/tiktok-sync.server";

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

  // A TikTok link turns this into an import from the merchant's own account,
  // and that claim is checked here rather than in the page. This endpoint is
  // reachable directly by anyone holding a session, so a UI-side check would
  // be decoration.
  //
  // Everything below runs before a Bunny asset is allocated, so a rejected
  // link costs nothing and leaves nothing behind.
  if (sourceUrl) {
    let post;
    try {
      post = await assertOwnedPost(shop, sourceUrl);
    } catch (error) {
      if (error instanceof TikTokNotConnectedError) {
        return Response.json({
          ok: false,
          error:
            "Connect your TikTok account first, so Shopdart knows which videos are yours.",
        });
      }
      if (error instanceof TikTokNotVerifiedError) {
        return Response.json({
          ok: false,
          error:
            "Finish verifying your TikTok account before adding videos from it.",
        });
      }
      if (error instanceof TikTokOwnershipError) {
        return Response.json({ ok: false, error: error.message });
      }
      if (error instanceof TikTokUnreachableError) {
        // Deliberately a refusal, not a pass. Ownership is established by
        // reading TikTok; when that read fails the question is unanswered, and
        // allowing the import anyway would reopen the hole this check closes.
        return Response.json({ ok: false, error: error.message });
      }
      return Response.json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "That TikTok link could not be checked.",
      });
    }

    const caption = await captionFor(post.url);

    origin = {
      source: VideoSource.TIKTOK,
      sourceRef: post.videoId,
      sourceUrl: post.url,
      caption,
      title: title.trim() || titleFromCaption(caption) || undefined,
    };
  }

  try {
    const { video, upload } = await beginUpload(shop, fileName, origin);
    if (origin.source === VideoSource.TIKTOK) await markSynced(shop.id);
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
