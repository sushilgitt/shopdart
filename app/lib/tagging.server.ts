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

/**
 * A variant as cached on the tag and published to the storefront.
 *
 * `id` is the numeric variant id, not the gid — the Ajax cart API wants the
 * bare number, and converting it here means the player never has to.
 */
export interface CachedVariant {
  id: string;
  title: string;
  price: number | null;
  available: boolean;
}

/**
 * Upper bound on cached variants per product.
 *
 * Shopify allows far more, but this JSON rides in a document every shopper
 * downloads. A picker with hundreds of entries is unusable anyway, so the
 * payload cost buys nothing past this point.
 */
const MAX_VARIANTS = 50;

function numericId(gid?: string | null): string | null {
  if (!gid) return null;
  const tail = gid.split("/").pop();
  return tail && /^\d+$/.test(tail) ? tail : null;
}

function toCachedVariants(
  variants: PickedProduct["variants"],
): CachedVariant[] {
  return (variants ?? [])
    .map((variant) => {
      const id = numericId(variant.id);
      if (!id) return null;
      const price = variant.price ? Number(variant.price) : null;
      return {
        id,
        title: variant.title ?? "",
        price: price !== null && Number.isFinite(price) ? price : null,
        // Absent means available: the picker treats only an explicit false as
        // sold out, so a missing field never hides a buyable variant.
        available: variant.availableForSale !== false,
      } satisfies CachedVariant;
    })
    .filter((variant): variant is CachedVariant => variant !== null)
    .slice(0, MAX_VARIANTS);
}

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
        // size. Multi-variant products are handled by the in-player picker,
        // built from the cached list below.
        variantGid:
          product.variants?.length === 1 ? (variant?.id ?? null) : null,
        handle: product.handle ?? null,
        title: product.title ?? null,
        imageUrl: product.images?.[0]?.originalSrc ?? null,
        priceAmount:
          price !== null && Number.isFinite(price)
            ? new Prisma.Decimal(price)
            : null,
        variants: toCachedVariants(
          product.variants,
        ) as unknown as Prisma.InputJsonValue,
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
    variants?: CachedVariant[];
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
  if (data.variants !== undefined) {
    // Keeps the picker honest: a variant sold out or deleted since tagging
    // would otherwise stay buyable in the player until someone re-tagged it.
    patch.variants = data.variants as unknown as Prisma.InputJsonValue;
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
