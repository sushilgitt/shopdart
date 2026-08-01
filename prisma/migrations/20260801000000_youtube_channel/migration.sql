-- AlterTable
-- All nullable and additive: existing rows need no backfill and the deploy
-- needs no downtime.
ALTER TABLE "Shop" ADD COLUMN     "ytChannelId" TEXT,
ADD COLUMN     "ytChannelTitle" TEXT,
ADD COLUMN     "ytUploadsPlaylistId" TEXT,
ADD COLUMN     "ytLastSyncedAt" TIMESTAMP(3);
