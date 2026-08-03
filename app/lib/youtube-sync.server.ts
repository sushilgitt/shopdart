import { VideoSource, VideoStatus, type Shop } from "@prisma/client";
import prisma from "../db.server";
import {
  SHORTS_MAX_SECONDS,
  fetchUploads,
  fetchVideosByIds,
  watchUrl,
  type YouTubeVideo,
} from "./youtube.server";
import { PlanLimitError, assertCanAddVideo } from "./video.server";

export class YouTubeNotConnectedError extends Error {
  constructor() {
    super("This store has not connected a YouTube channel.");
    this.name = "YouTubeNotConnectedError";
  }
}

export class YouTubeNotVerifiedError extends Error {
  constructor() {
    super("This channel has not been verified as yours.");
    this.name = "YouTubeNotVerifiedError";
  }
}

/**
 * Guards every read of a merchant's channel.
 *
 * Verification is checked here rather than at the route, so no future caller
 * can reach the channel without going through the ownership gate.
 */
function assertVerified(shop: Shop): string {
  if (!shop.ytChannelId || !shop.ytUploadsPlaylistId) {
    throw new YouTubeNotConnectedError();
  }
  if (!shop.ytVerifiedAt) throw new YouTubeNotVerifiedError();
  return shop.ytUploadsPlaylistId;
}

/**
 * YouTube library sync.
 *
 * Structurally simpler than Instagram in two ways that matter:
 *
 *  - Nothing is re-hosted. YouTube's terms do not permit downloading, so we
 *    store the video id and the storefront embeds YouTube's player. There is
 *    no Bunny asset, no transcode, and therefore no PROCESSING state — rows
 *    are born READY.
 *  - There is no token. Public channels are read with a server-side API key,
 *    so nothing expires and nothing needs refreshing.
 */

/**
 * Attaches a channel Google has confirmed the merchant owns.
 *
 * There is deliberately no way to attach a channel by name. The only caller is
 * the OAuth callback, which receives the channel list straight from
 * `channels.list?mine=true`.
 */
export async function attachVerifiedChannel(
  shopId: string,
  channel: { id: string; title: string; uploadsPlaylistId: string },
): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      ytChannelId: channel.id,
      ytChannelTitle: channel.title,
      ytUploadsPlaylistId: channel.uploadsPlaylistId,
      ytVerifiedAt: new Date(),
    },
  });
}

export async function disconnectYouTube(shopId: string): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      ytChannelId: null,
      ytChannelTitle: null,
      ytUploadsPlaylistId: null,
      ytLastSyncedAt: null,
      ytVerifiedAt: null,
    },
  });
}

export interface BrowsableYouTubeVideo extends YouTubeVideo {
  /** True when this video is already in the merchant's live library. */
  imported: boolean;
}

/**
 * Lists a page of the channel's uploads, flagging ones already imported.
 *
 * `shortsOnly` filters on duration, because the Data API exposes no aspect
 * ratio — a 16:9 talking-head video letterboxed into a 9:16 carousel frame
 * looks broken, and duration is the only signal available to avoid it.
 */
export async function browseUploads(
  shop: Shop,
  options: { pageToken?: string; shortsOnly?: boolean } = {},
): Promise<{ videos: BrowsableYouTubeVideo[]; nextPageToken: string | null }> {
  const uploadsPlaylistId = assertVerified(shop);

  const page = await fetchUploads(uploadsPlaylistId, {
    pageToken: options.pageToken,
  });

  const candidates = (
    options.shortsOnly === false
      ? page.videos
      : page.videos.filter((video) => video.isShort)
    // Never offer a video the creator has blocked from embedding — it would
    // publish a player reading "Video unavailable" to every shopper.
  ).filter((video) => video.embeddable);

  if (candidates.length === 0) {
    return { videos: [], nextPageToken: page.nextPageToken };
  }

  const existing = await prisma.video.findMany({
    where: {
      shopId: shop.id,
      source: VideoSource.YOUTUBE,
      sourceRef: { in: candidates.map((video) => video.id) },
      // Archived videos are importable again, so they must not read as
      // already imported.
      archivedAt: null,
    },
    select: { sourceRef: true },
  });
  const importedIds = new Set(existing.map((video) => video.sourceRef));

  return {
    videos: candidates.map((video) => ({
      ...video,
      imported: importedIds.has(video.id),
    })),
    nextPageToken: page.nextPageToken,
  };
}

export interface YouTubeImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Adds selected YouTube videos to the library.
 *
 * Rows are created READY with no Bunny asset: the storefront embeds YouTube's
 * player, so there is nothing to encode and nothing to wait for.
 */
export async function importVideos(
  shop: Shop,
  videoIds: string[],
): Promise<YouTubeImportResult> {
  assertVerified(shop);

  const result: YouTubeImportResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // One unit per 50 videos, regardless of how far down the channel they sit.
  const found = await fetchVideosByIds(videoIds);

  for (const videoId of videoIds) {
    const video = found.get(videoId);
    if (!video) {
      result.failed += 1;
      result.errors.push(`Could not read details for one video.`);
      continue;
    }

    const existing = await prisma.video.findFirst({
      where: {
        shopId: shop.id,
        source: VideoSource.YOUTUBE,
        sourceRef: videoId,
      },
    });

    // Only a live row counts as imported; an archived one is revived below,
    // since (shopId, source, sourceRef) is unique and would reject an insert.
    if (existing && !existing.archivedAt) {
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

    const fields = {
      sourceUrl: watchUrl(videoId),
      title: video.title || "YouTube video",
      caption: video.description,
      posterUrl: video.thumbnailUrl,
      durationSec: video.durationSec,
      // No Bunny asset exists: the storefront embeds YouTube's own player, so
      // there is no progressive file or HLS playlist to point at.
      bunnyVideoId: null,
      mp4Url: null,
      hlsUrl: null,
      status: VideoStatus.READY,
      errorMessage: null,
    };

    try {
      if (existing) {
        await prisma.video.update({
          where: { id: existing.id },
          data: { ...fields, archivedAt: null },
        });
      } else {
        await prisma.video.create({
          data: {
            shopId: shop.id,
            source: VideoSource.YOUTUBE,
            sourceRef: videoId,
            ...fields,
          },
        });
      }
      result.imported += 1;
    } catch (error) {
      console.error(`YouTube import failed for ${videoId}`, error);
      result.failed += 1;
      result.errors.push("Could not import one video.");
    }
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { ytLastSyncedAt: new Date() },
  });

  return result;
}

export { SHORTS_MAX_SECONDS };
