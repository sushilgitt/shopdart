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

/** The slice of the Admin API client this module needs. */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * Authoritative product data, read from the Admin API rather than from the
 * resource picker's callback payload.
 *
 * The picker is a selection UI, not a data source: depending on the App Bridge
 * version and how the picker was opened it may return products with no
 * `variants` array at all. When that happened every tag was written with
 * `variantGid: null` and `variants: []`, and the storefront player — which has
 * no Admin API of its own and can only render what the payload contains — fell
 * through to a bare "View" link. No in-player add to cart meant no ADD_TO_CART
 * event and no cart attributes, so nothing downstream could ever be attributed.
 *
 * Reading the variants here instead makes the cache correct regardless of what
 * the picker hands back.
 */
const PRODUCT_DETAILS_QUERY = `#graphql
  query shopdartTaggedProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        priceRangeV2 {
          minVariantPrice {
            amount
          }
        }
        variants(first: ${MAX_VARIANTS}) {
          nodes {
            id
            title
            price
            availableForSale
          }
        }
      }
    }
  }
`;

interface AdminProductNode {
  id?: string;
  title?: string | null;
  handle?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string | null } | null } | null } | null;
  priceRangeV2?: { minVariantPrice?: { amount?: string | null } | null } | null;
  variants?: {
    nodes?: {
      id?: string;
      title?: string | null;
      price?: string | null;
      availableForSale?: boolean | null;
    }[];
  } | null;
}

export interface ProductDetails {
  handle: string | null;
  title: string | null;
  imageUrl: string | null;
  priceAmount: number | null;
  variants: CachedVariant[];
}

/**
 * Products per Admin API call.
 *
 * Each product pulls up to MAX_VARIANTS children, and the query cost is roughly
 * the product of the two. 25 keeps a full batch comfortably inside the
 * calculated-cost ceiling on a standard plan.
 */
const PRODUCTS_PER_REQUEST = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Reads current details for the given product GIDs.
 *
 * Products the merchant can no longer see — deleted, or outside the app's
 * scope — simply come back as null nodes and are absent from the map, so the
 * caller can tell "not found" from "found with no variants".
 */
export async function fetchProductDetails(
  admin: AdminGraphqlClient,
  productGids: string[],
): Promise<Map<string, ProductDetails>> {
  const found = new Map<string, ProductDetails>();
  const unique = [...new Set(productGids.filter(Boolean))];
  if (unique.length === 0) return found;

  for (const ids of chunk(unique, PRODUCTS_PER_REQUEST)) {
    const response = await admin.graphql(PRODUCT_DETAILS_QUERY, {
      variables: { ids },
    });
    const body = (await response.json()) as {
      data?: { nodes?: (AdminProductNode | null)[] };
    };

    for (const node of body?.data?.nodes ?? []) {
      if (!node?.id) continue;

      const amount = Number(node.priceRangeV2?.minVariantPrice?.amount);
      const variants = (node.variants?.nodes ?? [])
        .map((variant) => {
          const id = numericId(variant?.id);
          if (!id) return null;
          const price = Number(variant?.price);
          return {
            id,
            title: variant?.title ?? "",
            price: Number.isFinite(price) ? price : null,
            // Only an explicit false means sold out, so a missing field never
            // hides a variant the merchant is happy to sell.
            available: variant?.availableForSale !== false,
          } satisfies CachedVariant;
        })
        .filter((variant): variant is CachedVariant => variant !== null)
        .slice(0, MAX_VARIANTS);

      found.set(node.id, {
        handle: node.handle ?? null,
        title: node.title ?? null,
        imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
        priceAmount: Number.isFinite(amount) ? amount : null,
        variants,
      });
    }
  }

  return found;
}

/** Falls back to whatever the picker gave us when the Admin API is unreachable. */
function detailsFromPicked(product: PickedProduct): ProductDetails {
  const price = product.variants?.[0]?.price
    ? Number(product.variants[0].price)
    : null;

  return {
    handle: product.handle ?? null,
    title: product.title ?? null,
    imageUrl: product.images?.[0]?.originalSrc ?? null,
    priceAmount: price !== null && Number.isFinite(price) ? price : null,
    variants: toCachedVariants(product.variants),
  };
}

/**
 * Pins a variant only when the product has exactly one.
 *
 * Pre-selecting on a multi-variant product silently sells the wrong size; those
 * are handled by the in-player picker built from the cached variant list.
 */
function soleVariantGid(variants: CachedVariant[]): string | null {
  return variants.length === 1
    ? `gid://shopify/ProductVariant/${variants[0].id}`
    : null;
}

/**
 * Attaches products to a video, ignoring any already tagged.
 *
 * Uses skipDuplicates against the (videoId, productGid) unique index so a
 * merchant re-opening the picker with existing selections doesn't error.
 */
export async function tagProducts(
  admin: AdminGraphqlClient,
  shopId: string,
  videoId: string,
  products: PickedProduct[],
): Promise<number> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, shopId },
    select: { id: true },
  });
  if (!video) return 0;

  const picked = products.filter((product) => product.id);
  if (picked.length === 0) return 0;

  let details = new Map<string, ProductDetails>();
  try {
    details = await fetchProductDetails(
      admin,
      picked.map((product) => product.id),
    );
  } catch (error) {
    // Degrade to the picker payload rather than blocking the merchant. The
    // products/update webhook and the repair sweep will both correct it later.
    console.error("Could not read product details while tagging", error);
  }

  const start = await prisma.productTag.count({ where: { videoId } });

  const rows = picked.map((product, index) => {
    const detail = details.get(product.id) ?? detailsFromPicked(product);

    return {
      videoId,
      productGid: product.id,
      variantGid: soleVariantGid(detail.variants),
      handle: detail.handle,
      title: detail.title,
      imageUrl: detail.imageUrl,
      priceAmount:
        detail.priceAmount !== null
          ? new Prisma.Decimal(detail.priceAmount)
          : null,
      variants: detail.variants as unknown as Prisma.InputJsonValue,
      position: start + index,
    };
  });

  const result = await prisma.productTag.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Repairs tags whose cached variant list is empty.
 *
 * Tags written before variants were read from the Admin API carry `variants:
 * []`, which the player can only render as a link out to the product page.
 * Those tags are already published and sitting in a CDN-cached payload, so they
 * cannot fix themselves — this backfills them the next time the merchant opens
 * the video.
 *
 * Returns the number of tags repaired. Cheap in the normal case: the query
 * matches nothing once a shop has been healed.
 */
export async function repairEmptyVariantTags(
  admin: AdminGraphqlClient,
  shopId: string,
  videoId?: string,
): Promise<number> {
  // Wrapped whole: this is an opportunistic repair running inside a loader, and
  // it must never be the reason a merchant cannot open their own library.
  try {
    const broken = await prisma.productTag.findMany({
      where: {
        video: { shopId, ...(videoId ? { id: videoId } : {}) },
        OR: [
          { variants: { equals: Prisma.DbNull } },
          { variants: { equals: [] } },
        ],
      },
      select: { id: true, productGid: true },
      take: 100,
    });
    if (broken.length === 0) return 0;

    const details = await fetchProductDetails(
      admin,
      broken.map((tag) => tag.productGid),
    );

    let repaired = 0;
    for (const tag of broken) {
      const detail = details.get(tag.productGid);
      if (!detail || detail.variants.length === 0) continue;

      await prisma.productTag.update({
        where: { id: tag.id },
        data: {
          variantGid: soleVariantGid(detail.variants),
          handle: detail.handle,
          title: detail.title,
          imageUrl: detail.imageUrl,
          priceAmount:
            detail.priceAmount !== null
              ? new Prisma.Decimal(detail.priceAmount)
              : null,
          variants: detail.variants as unknown as Prisma.InputJsonValue,
        },
      });
      repaired += 1;
    }

    if (repaired > 0) {
      console.log(`Repaired variants on ${repaired} product tag(s)`);
    }
    return repaired;
  } catch (error) {
    console.error("Variant repair sweep failed", error);
    return 0;
  }
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
