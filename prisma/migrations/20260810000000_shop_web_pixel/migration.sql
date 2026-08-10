-- AlterTable
-- Nullable and additive. Holds the shop's WebPixel GID once registered, so the
-- admin does not spend an Admin API call re-checking on every page load.
-- Existing rows are null and register on their next authenticated load.
ALTER TABLE "Shop" ADD COLUMN "webPixelId" TEXT;
