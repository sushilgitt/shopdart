-- AlterTable
-- Nullable and additive. Existing rows become "unverified", which is correct:
-- any channel attached before ownership checks existed should have to prove
-- itself before it can be browsed or imported again.
ALTER TABLE "Shop" ADD COLUMN "ytVerifiedAt" TIMESTAMP(3);
