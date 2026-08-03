-- AlterTable
-- Nullable and additive. Tags created before this migration simply have no
-- cached variants and keep their existing behaviour until re-tagged or until
-- the next products/update webhook refreshes them.
ALTER TABLE "ProductTag" ADD COLUMN "variants" JSONB;
