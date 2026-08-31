-- AlterTable
-- Additive and nullable. Existing shops have no TikTok account attached, which
-- is exactly the state that makes importing refuse to run until one is proven.
ALTER TABLE "Shop" ADD COLUMN "ttUsername" TEXT;
ALTER TABLE "Shop" ADD COLUMN "ttVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "ttLastSyncedAt" TIMESTAMP(3);
