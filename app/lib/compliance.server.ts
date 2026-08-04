import prisma from "../db.server";
import { deleteBunnyVideo } from "./bunny.server";

/**
 * Shopify's mandatory GDPR compliance webhooks.
 *
 * Every public app must handle all three or it cannot pass review. They are
 * deliberately in one module because the honest answer to two of them depends
 * on knowing exactly what this app stores, which is:
 *
 *  - Nothing that identifies a shopper. Session keys are one-way hashes and
 *    are never linked to a customer record.
 *  - Order id, total and currency on PURCHASE events, written by revenue
 *    attribution. That is the only customer-adjacent data we hold.
 */

export interface CustomersDataRequestPayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string };
  orders_requested?: number[];
}

export interface CustomersRedactPayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string };
  orders_to_redact?: number[];
}

/**
 * A merchant asked what personal data we hold for one of their customers.
 *
 * Shopify provides no channel to answer through — the response is delivered to
 * the merchant out of band within 30 days — so this records the request and
 * reports what we could return.
 *
 * In practice that is almost always nothing: analytics rows carry a hashed
 * session key with no path back to a person, and attribution stores an order
 * id, not a customer.
 */
export async function handleCustomersDataRequest(
  shopDomain: string,
  payload: CustomersDataRequestPayload,
): Promise<{ orderEvents: number }> {
  const orderIds = payload.orders_requested ?? [];
  if (orderIds.length === 0) return { orderEvents: 0 };

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return { orderEvents: 0 };

  const orderEvents = await prisma.videoEvent.count({
    where: {
      shopId: shop.id,
      orderGid: { in: orderIds.map((id) => `gid://shopify/Order/${id}`) },
    },
  });

  return { orderEvents };
}

/**
 * Erases what we hold for a specific customer.
 *
 * Only attribution rows can relate to one, and they are matched by order
 * rather than by person. The rows are deleted outright rather than anonymised:
 * their only remaining value would be an order total, which is not worth
 * keeping against a redaction request.
 */
export async function handleCustomersRedact(
  shopDomain: string,
  payload: CustomersRedactPayload,
): Promise<{ deleted: number }> {
  const orderIds = payload.orders_to_redact ?? [];
  if (orderIds.length === 0) return { deleted: 0 };

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return { deleted: 0 };

  const result = await prisma.videoEvent.deleteMany({
    where: {
      shopId: shop.id,
      orderGid: { in: orderIds.map((id) => `gid://shopify/Order/${id}`) },
    },
  });

  return { deleted: result.count };
}

/**
 * Purges everything belonging to a shop, 48 hours after uninstall.
 *
 * This is the one genuinely destructive handler, and it must be: keeping a
 * merchant's data after Shopify has told us to delete it is the failure this
 * webhook exists to prevent.
 *
 * Bunny assets are removed first. Deleting the Shop row cascades to videos,
 * widgets, tags, events and counters, and once those rows are gone we no
 * longer know which remote files were ours — orphaning them would leave the
 * merchant's video content on our CDN indefinitely.
 */
export async function handleShopRedact(
  shopDomain: string,
): Promise<{ videosDeleted: number; shopDeleted: boolean }> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });

  // Sessions are keyed by domain rather than by shop id, so they are removed
  // separately whether or not a Shop row still exists.
  await prisma.session.deleteMany({ where: { shop: shopDomain } });

  if (!shop) return { videosDeleted: 0, shopDeleted: false };

  const videos = await prisma.video.findMany({
    where: { shopId: shop.id, bunnyVideoId: { not: null } },
    select: { bunnyVideoId: true },
  });

  let videosDeleted = 0;
  for (const video of videos) {
    try {
      await deleteBunnyVideo(video.bunnyVideoId!);
      videosDeleted += 1;
    } catch (error) {
      // Keep going: a stale remote asset is recoverable, failing to honour a
      // redaction request is not.
      console.error(`Bunny delete failed for ${video.bunnyVideoId}`, error);
    }
  }

  await prisma.shop.delete({ where: { id: shop.id } });

  return { videosDeleted, shopDeleted: true };
}
