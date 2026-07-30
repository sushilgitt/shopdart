import { Prisma } from "@prisma/client";
import prisma from "../db.server";

/**
 * Product tagging.
 *
 * Product title, image and price are denormalised onto ProductTag rather than
 * fetched at render time. The storefront payload has to be a static CDN file —
 * it cannot call the Admin API — so the copy here is what shoppers actually
 * see. It's kept current by the products/update webhook.
 */

/** Shape returned by the App Bridge resource picker for a product. */
export interface PickedProduct {
  id: string;
  title?: string;
  handle?: string;
  images?: { originalSrc?: string; altText?: string }[];
  variants?: {
    id?: string;
    title?: string;
    price?: string;
    availableForSale?: boolean;
  }[];
}


/**
 * Attaches products to a video, ignoring any already tagged.
 *
 * Uses skipDuplicates against the (videoId, productGid) unique index so a
 * merchant re-opening the picker with existing selections doesn't error.
 */
export async function tagProducts(
  shopId: string,
  videoId: string,
  products: PickedProduct[],
): Promise<number> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, shopId },
    select: { id: true },
  });
  if (!video) return 0;

  const start = await prisma.productTag.count({ where: { videoId } });

  const rows = products
    .filter((product) => product.id)
    .map((product, index) => {
      const variant = product.variants?.[0];
      const price = variant?.price ? Number(variant.price) : null;

      return {
        videoId,
        productGid: product.id,
        // Only pin a variant when the product has exactly one — otherwise the
        // shopper should choose, and pre-selecting silently sells the wrong
        // size.
        variantGid:
          product.variants?.length === 1 ? (variant?.id ?? null) : null,
        handle: product.handle ?? null,
        title: product.title ?? null,
        imageUrl: product.images?.[0]?.originalSrc ?? null,
        priceAmount:
          price !== null && Number.isFinite(price)
            ? new Prisma.Decimal(price)
            : null,
        position: start + index,
      };
    });

  if (rows.length === 0) return 0;

  const result = await prisma.productTag.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return result.count;
}

export async function untagProduct(
  shopId: string,
  videoId: string,
  tagId: string,
): Promise<void> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, shopId },
    select: { id: true },
  });
  if (!video) return;

  await prisma.productTag.deleteMany({ where: { id: tagId, videoId } });
}

/**
 * Sets the window during which a tag is shown.
 *
 * Null start and end mean the product is pinned for the whole clip, which is
 * the common case. Timed tags matter for multi-product try-on videos.
 */
export async function setTagTiming(
  shopId: string,
  videoId: string,
  tagId: string,
  startSec: number | null,
  endSec: number | null,
): Promise<void> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, shopId },
    select: { id: true, durationSec: true },
  });
  if (!video) return;

  const max = video.durationSec ?? Number.MAX_SAFE_INTEGER;
  const start =
    startSec === null ? null : Math.max(0, Math.min(startSec, max));
  let end = endSec === null ? null : Math.max(0, Math.min(endSec, max));

  // An end before the start would hide the tag entirely with no feedback.
  if (start !== null && end !== null && end <= start) end = null;

  await prisma.productTag.updateMany({
    where: { id: tagId, videoId },
    data: { startSec: start, endSec: end },
  });
}

/**
 * Refreshes cached product copy across every shop that tagged it.
 *
 * Driven by the products/update webhook. Without this, a merchant renaming a
 * product or changing its price would keep showing stale details — and a wrong
 * price in a shoppable video is a support ticket at best.
 */
export async function refreshCachedProduct(
  productGid: string,
  data: {
    title?: string | null;
    handle?: string | null;
    imageUrl?: string | null;
    priceAmount?: number | null;
  },
): Promise<number> {
  const patch: Prisma.ProductTagUpdateManyMutationInput = {};
  if (data.title !== undefined) patch.title = data.title;
  if (data.handle !== undefined) patch.handle = data.handle;
  if (data.imageUrl !== undefined) patch.imageUrl = data.imageUrl;
  if (data.priceAmount !== undefined) {
    patch.priceAmount =
      data.priceAmount === null ? null : new Prisma.Decimal(data.priceAmount);
  }
  if (Object.keys(patch).length === 0) return 0;

  const result = await prisma.productTag.updateMany({
    where: { productGid },
    data: patch,
  });
  return result.count;
}

/** Drops tags for a product that no longer exists. */
export async function removeTagsForProduct(productGid: string): Promise<number> {
  const result = await prisma.productTag.deleteMany({ where: { productGid } });
  return result.count;
}
