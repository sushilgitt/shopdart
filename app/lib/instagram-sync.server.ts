import { VideoSource, VideoStatus, type Shop } from "@prisma/client";
import prisma from "../db.server";
import { decrypt, encrypt } from "./crypto.server";
import { createBunnyVideo, fetchBunnyVideoFromUrl } from "./bunny.server";
import {
  fetchMediaById,
  fetchReels,
  refreshLongLivedToken,
  type InstagramMedia,
} from "./instagram.server";
import { PlanLimitError, assertCanAddVideo } from "./video.server";

export class InstagramNotConnectedError extends Error {
  constructor() {
    super("This store has not connected an Instagram account.");
    this.name = "InstagramNotConnectedError";
  }
}

export class InstagramTokenExpiredError extends Error {
  constructor() {
    super("The Instagram connection has expired and must be set up again.");
    this.name = "InstagramTokenExpiredError";
  }
}

/**
 * Returns a usable access token, refreshing it opportunistically.
 *
 * Meta gives 60 days and allows refresh only while the token is still valid and
 * at least 24 hours old. Refreshing whenever we're inside the last two weeks
 * means normal app usage keeps the connection alive indefinitely, and the
 * scheduled job only has to catch merchants who haven't opened the app.
 */
export async function getAccessToken(shop: Shop): Promise<string> {
  if (!shop.igAccessToken) throw new InstagramNotConnectedError();

  const expiresAt = shop.igTokenExpiresAt;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new InstagramTokenExpiredError();
  }

  let token = decrypt(shop.igAccessToken);

  const twoWeeks = 14 * 24 * 3600 * 1000;
  const dueForRefresh =
    expiresAt && expiresAt.getTime() - Date.now() < twoWeeks;

  if (dueForRefresh) {
    try {
      const refreshed = await refreshLongLivedToken(token);
      token = refreshed.accessToken;
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          igAccessToken: encrypt(refreshed.accessToken),
          igTokenExpiresAt: refreshed.expiresAt,
        },
      });
    } catch (error) {
      // A failed refresh is not fatal while the current token still works.
      console.error(`Instagram token refresh failed for ${shop.domain}`, error);
    }
  }

  return token;
}

export interface BrowsableReel extends InstagramMedia {
  /** True when this reel is already in the merchant's Shopdart library. */
  imported: boolean;
}

/** Lists the merchant's reels, flagging ones already imported. */
export async function browseReels(
  shop: Shop,
  limit = 50,
): Promise<BrowsableReel[]> {
  const token = await getAccessToken(shop);
  const reels = await fetchReels(token, limit);

  const existing = await prisma.video.findMany({
    where: {
      shopId: shop.id,
      source: VideoSource.INSTAGRAM,
      sourceRef: { in: reels.map((r) => r.id) },
    },
    select: { sourceRef: true },
  });
  const importedIds = new Set(existing.map((v) => v.sourceRef));

  return reels.map((reel) => ({ ...reel, imported: importedIds.has(reel.id) }));
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Imports selected reels into Bunny Stream.
 *
 * `media_url` from Instagram's CDN expires within hours, so each reel is
 * re-read immediately before ingest rather than relying on a URL captured when
 * the list was rendered. Bunny pulls the file server-side, so the video never
 * passes through us.
 */
export async function importReels(
  shop: Shop,
  mediaIds: string[],
): Promise<ImportResult> {
  const token = await getAccessToken(shop);
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const mediaId of mediaIds) {
    // Dedupe: the unique index on (shopId, source, sourceRef) would reject this
    // anyway, but catching it here keeps the counts honest.
    const existing = await prisma.video.findFirst({
      where: {
        shopId: shop.id,
        source: VideoSource.INSTAGRAM,
        sourceRef: mediaId,
      },
    });
    if (existing) {
      result.skipped += 1;
      continue;
    }

    try {
      await assertCanAddVideo(shop);
    } catch (error) {
      if (error instanceof PlanLimitError) {
        result.errors.push(
          `Stopped at your plan limit of ${error.limit} videos.`,
        );
        break;
      }
      throw error;
    }

    try {
      const media = await fetchMediaById(mediaId, token);
      if (!media?.mediaUrl) {
        result.failed += 1;
        result.errors.push(`Reel ${mediaId} has no downloadable video.`);
        continue;
      }

      const title = titleFromCaption(media.caption) || "Instagram reel";
      const bunny = await createBunnyVideo(title);

      await prisma.video.create({
        data: {
          shopId: shop.id,
          source: VideoSource.INSTAGRAM,
          sourceRef: media.id,
          sourceUrl: media.permalink,
          title,
          caption: media.caption,
          bunnyVideoId: bunny.guid,
          status: VideoStatus.PROCESSING,
        },
      });

      // Bunny pulls the file itself. Fired after the row exists so the
      // transcode webhook always finds something to update.
      await fetchBunnyVideoFromUrl(bunny.guid, media.mediaUrl);
      result.imported += 1;
    } catch (error) {
      console.error(`Import failed for reel ${mediaId}`, error);
      result.failed += 1;
      result.errors.push(`Could not import one reel.`);
    }
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { igLastSyncedAt: new Date() },
  });

  return result;
}

/** Clears the connection. The token is discarded, not just orphaned. */
export async function disconnectInstagram(shopId: string): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      igUserId: null,
      igUsername: null,
      igAccessToken: null,
      igTokenExpiresAt: null,
      igLastSyncedAt: null,
    },
  });
}

/**
 * Refreshes tokens nearing expiry across every connected shop. Intended for a
 * daily cron: a token that lapses cannot be renewed, and the merchant then has
 * to reconnect manually.
 */
export async function refreshExpiringTokens(
  withinDays = 14,
): Promise<{ refreshed: number; failed: number }> {
  const cutoff = new Date(Date.now() + withinDays * 24 * 3600 * 1000);
  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      igAccessToken: { not: null },
      igTokenExpiresAt: { lt: cutoff, gt: new Date() },
    },
  });

  let refreshed = 0;
  let failed = 0;

  for (const shop of shops) {
    try {
      const current = decrypt(shop.igAccessToken!);
      const next = await refreshLongLivedToken(current);
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          igAccessToken: encrypt(next.accessToken),
          igTokenExpiresAt: next.expiresAt,
        },
      });
      refreshed += 1;
    } catch (error) {
      console.error(`Token refresh failed for ${shop.domain}`, error);
      failed += 1;
    }
  }

  return { refreshed, failed };
}

function titleFromCaption(caption?: string): string {
  if (!caption) return "";
  const firstLine = caption.split("\n")[0].trim();
  return firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
}
