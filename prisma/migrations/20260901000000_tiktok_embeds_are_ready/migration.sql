-- Promote TikTok posts staged before embeds were supported.
--
-- Staging used to park a post in PENDING until the merchant supplied the
-- original file, because there was no way to play it otherwise. The storefront
-- now embeds TikTok's own player, so those rows are playable as they stand and
-- PENDING would only keep them out of the payload, which publishes READY only.
--
-- Narrow on purpose. It touches TikTok rows that carry an external identity and
-- have no Bunny asset — exactly the rows staging created. A row with an asset
-- is mid-upload or already hosted and is left alone.
UPDATE "Video"
SET status = 'READY'
WHERE source = 'TIKTOK'
  AND status = 'PENDING'
  AND "bunnyVideoId" IS NULL
  AND "sourceRef" IS NOT NULL;
