import { VideoSource, VideoStatus, type Shop, type Video } from "@prisma/client";
import prisma from "../db.server";
import { planFor } from "./plans";
import {
  BunnyApiStatus,
  BunnyWebhookStatus,
  bestMp4Resolution,
  createBunnyVideo,
  deleteBunnyVideo,
  getBunnyVideo,
  hlsUrl,
  mp4Url,
  posterUrl,
  presignUpload,
  type PresignedUpload,
} from "./bunny.server";

export class PlanLimitError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Video limit reached: ${used} of ${limit} used.`);
    this.name = "PlanLimitError";
  }
}

/** Videos counting against the plan cap. Archived videos are excluded. */
export async function countActiveVideos(shopId: string): Promise<number> {
  return prisma.video.count({
    where: { shopId, archivedAt: null },
  });
}

export async function assertCanAddVideo(shop: Shop): Promise<void> {
  const limit = planFor(shop.plan).videos;
  const used = await countActiveVideos(shop.id);
  if (used >= limit) throw new PlanLimitError(used, limit);
}

/**
 * Allocates a Bunny video and returns credentials for a direct
 * browser-to-Bunny upload.
 *
 * The Video row is created up front in UPLOADING so the library shows the item
 * immediately and the plan cap accounts for it. If the browser never completes
 * the upload the row is reaped by `reapStalledUploads`.
 */
export async function beginUpload(
  shop: Shop,
  fileName: string,
  title?: string,
): Promise<{ video: Video; upload: PresignedUpload }> {
  await assertCanAddVideo(shop);

  const displayTitle = title?.trim() || stripExtension(fileName);
  const bunny = await createBunnyVideo(displayTitle);

  const video = await prisma.video.create({
    data: {
      shopId: shop.id,
      source: VideoSource.UPLOAD,
      sourceRef: fileName,
      title: displayTitle,
      bunnyVideoId: bunny.guid,
      status: VideoStatus.UPLOADING,
    },
  });

  return { video, upload: presignUpload(bunny.guid) };
}

/**
 * Applies a Bunny webhook status to the matching video.
 *
 * Bunny fires ResolutionFinished before Finished, and the video is already
 * playable at that point, so both promote to READY. Treating only Finished as
 * ready would leave merchants staring at a spinner for a video they could
 * already publish.
 */
export async function applyWebhookStatus(
  bunnyVideoId: string,
  status: BunnyWebhookStatus,
): Promise<Video | null> {
  const video = await prisma.video.findUnique({ where: { bunnyVideoId } });
  if (!video) return null;

  switch (status) {
    case BunnyWebhookStatus.Finished:
    case BunnyWebhookStatus.ResolutionFinished:
      return promoteToReady(video);

    case BunnyWebhookStatus.Failed:
    case BunnyWebhookStatus.PresignedUploadFailed:
      return prisma.video.update({
        where: { id: video.id },
        data: {
          status: VideoStatus.FAILED,
          errorMessage:
            status === BunnyWebhookStatus.PresignedUploadFailed
              ? "Upload failed before encoding started."
              : "Bunny Stream could not encode this video.",
        },
      });

    case BunnyWebhookStatus.Queued:
    case BunnyWebhookStatus.Processing:
    case BunnyWebhookStatus.Encoding:
      // Don't regress a video that is already READY — ResolutionFinished can
      // arrive before the remaining renditions report Encoding.
      if (video.status === VideoStatus.READY) return video;
      return prisma.video.update({
        where: { id: video.id },
        data: { status: VideoStatus.PROCESSING },
      });

    case BunnyWebhookStatus.PresignedUploadStarted:
    case BunnyWebhookStatus.PresignedUploadFinished:
      if (video.status === VideoStatus.READY) return video;
      return prisma.video.update({
        where: { id: video.id },
        data: { status: VideoStatus.PROCESSING },
      });

    default:
      // Captions / title generation — nothing to do.
      return video;
  }
}

/** Reads authoritative metadata from Bunny and marks the video playable. */
export async function promoteToReady(video: Video): Promise<Video> {
  if (!video.bunnyVideoId) return video;

  const remote = await getBunnyVideo(video.bunnyVideoId);
  const resolution = bestMp4Resolution(remote.availableResolutions);

  return prisma.video.update({
    where: { id: video.id },
    data: {
      status: VideoStatus.READY,
      durationSec: remote.length || null,
      width: remote.width || null,
      height: remote.height || null,
      sizeBytes: remote.storageSize ? BigInt(remote.storageSize) : null,
      posterUrl: posterUrl(video.bunnyVideoId, remote.thumbnailFileName),
      hlsUrl: hlsUrl(video.bunnyVideoId),
      mp4Url: mp4Url(video.bunnyVideoId, resolution),
      errorMessage: null,
    },
  });
}

/**
 * Archives a video and removes it from Bunny.
 *
 * Soft-deleted locally so analytics keep resolving, but the Bunny asset is
 * deleted outright — storage is billed per minute stored and merchants should
 * not pay for content they removed.
 */
export async function archiveVideo(shopId: string, videoId: string): Promise<void> {
  const video = await prisma.video.findFirst({ where: { id: videoId, shopId } });
  if (!video) return;

  if (video.bunnyVideoId) {
    try {
      await deleteBunnyVideo(video.bunnyVideoId);
    } catch (error) {
      // Keep archiving even if Bunny is unreachable — a stale remote asset is
      // recoverable, a merchant blocked from deleting is not.
      console.error(`Bunny delete failed for ${video.bunnyVideoId}`, error);
    }
  }

  await prisma.video.update({
    where: { id: video.id },
    data: { archivedAt: new Date(), status: VideoStatus.FAILED },
  });
}

/**
 * Promotes videos whose transcode webhook never arrived.
 *
 * Bunny fires each status change exactly once and never replays it. A webhook
 * dropped in flight — or one that fired before the library had a webhook URL
 * configured at all — leaves a video stuck in PROCESSING permanently, with no
 * path back and nothing surfaced to the merchant. Polling Bunny for anything
 * that has sat in PROCESSING past the grace period closes that hole.
 *
 * Cheap to run: the matched set is empty in the normal case, because the
 * webhook usually wins.
 */
export async function reconcileProcessingVideos(
  olderThanMinutes = 15,
  limit = 50,
): Promise<{ promoted: number; failed: number; pending: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const stuck = await prisma.video.findMany({
    where: {
      status: VideoStatus.PROCESSING,
      bunnyVideoId: { not: null },
      archivedAt: null,
      updatedAt: { lt: cutoff },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  let promoted = 0;
  let failed = 0;
  let pending = 0;

  for (const video of stuck) {
    try {
      const remote = await getBunnyVideo(video.bunnyVideoId!);

      // Only these two are definitively playable. JitSegmenting is still in
      // flight, and promoting on it would publish a video that 404s.
      if (
        remote.status === BunnyApiStatus.Finished ||
        remote.status === BunnyApiStatus.JitPlaylistsCreated
      ) {
        await promoteToReady(video);
        promoted += 1;
        continue;
      }

      if (
        remote.status === BunnyApiStatus.Error ||
        remote.status === BunnyApiStatus.UploadFailed
      ) {
        await prisma.video.update({
          where: { id: video.id },
          data: {
            status: VideoStatus.FAILED,
            errorMessage: "Bunny Stream could not encode this video.",
          },
        });
        failed += 1;
        continue;
      }

      pending += 1;
    } catch (error) {
      // A Bunny outage or a deleted remote asset shouldn't abort the sweep —
      // the rest of the batch still deserves a chance.
      console.error(`Reconcile failed for video ${video.id}`, error);
      pending += 1;
    }
  }

  return { promoted, failed, pending };
}

/**
 * Fails uploads abandoned mid-flight so they stop occupying the plan cap.
 * The presigned credentials last an hour, so anything still UPLOADING after
 * two is never going to arrive.
 */
export async function reapStalledUploads(olderThanHours = 2): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000);
  const result = await prisma.video.updateMany({
    where: { status: VideoStatus.UPLOADING, createdAt: { lt: cutoff } },
    data: {
      status: VideoStatus.FAILED,
      errorMessage: "Upload did not complete.",
    },
  });
  return result.count;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "Untitled";
}
