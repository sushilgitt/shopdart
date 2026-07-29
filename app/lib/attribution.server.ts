import { EventType, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { currentPeriod } from "./plans";

/**
 * Revenue attribution.
 *
 * Deterministic, not modelled. When a shopper adds to cart from the player,
 * the player writes cart attributes; those survive into the order, and the
 * orders/create webhook reads them back. A sale is credited to the video that
 * actually caused it rather than to whatever was viewed nearby.
 *
 * Web Pixels cannot do this job: they run in a sandboxed worker with no DOM
 * access, so they can never observe our player.
 */

/** Cart attribute keys. Leading underscore hides them from the shopper. */
export const ATTR_VIDEO = "_shopdart_video";
export const ATTR_WIDGET = "_shopdart_widget";
export const ATTR_SESSION = "_shopdart_session";

interface OrderWebhookPayload {
  id?: number;
  admin_graphql_api_id?: string;
  total_price?: string;
  currency?: string;
  note_attributes?: { name?: string; value?: string }[];
  line_items?: { price?: string; quantity?: number }[];
}

function readAttribute(
  payload: OrderWebhookPayload,
  key: string,
): string | null {
  const found = (payload.note_attributes ?? []).find(
    (attribute) => attribute.name === key,
  );
  return found?.value?.trim() || null;
}

/**
 * Records a purchase against the video that drove it.
 *
 * The (orderGid, videoId, type) unique index makes this idempotent — Shopify
 * retries webhooks, and a duplicate would inflate the merchant's reported
 * revenue.
 */
export async function attributeOrder(
  shopDomain: string,
  payload: OrderWebhookPayload,
): Promise<boolean> {
  const videoId = readAttribute(payload, ATTR_VIDEO);
  if (!videoId) return false;

  const orderGid =
    payload.admin_graphql_api_id ??
    (payload.id ? `gid://shopify/Order/${payload.id}` : null);
  if (!orderGid) return false;

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return false;

  // Confirm the video belongs to this shop before crediting anything.
  const video = await prisma.video.findFirst({
    where: { id: videoId, shopId: shop.id },
    select: { id: true },
  });
  if (!video) return false;

  const widgetId = readAttribute(payload, ATTR_WIDGET);
  const session = readAttribute(payload, ATTR_SESSION) ?? "unknown";
  const total = Number(payload.total_price);
  const value = Number.isFinite(total) ? total : 0;

  try {
    await prisma.videoEvent.create({
      data: {
        shopId: shop.id,
        videoId: video.id,
        widgetId: widgetId ?? null,
        type: EventType.PURCHASE,
        sessionKey: session,
        orderGid,
        value: new Prisma.Decimal(value),
        currencyCode: payload.currency ?? null,
      },
    });
  } catch (error) {
    // Unique violation means this order was already attributed on an earlier
    // delivery of the same webhook.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }

  await prisma.usageCounter.upsert({
    where: { shopId_period: { shopId: shop.id, period: currentPeriod() } },
    create: {
      shopId: shop.id,
      period: currentPeriod(),
      orders: 1,
      revenue: new Prisma.Decimal(value),
    },
    update: {
      orders: { increment: 1 },
      revenue: { increment: new Prisma.Decimal(value) },
    },
  });

  return true;
}

export interface VideoPerformance {
  videoId: string;
  title: string;
  posterUrl: string | null;
  impressions: number;
  views: number;
  clicks: number;
  addToCarts: number;
  orders: number;
  revenue: number;
}

/**
 * Per-video performance for a period.
 *
 * Grouped in SQL rather than pulled into memory: a busy shop accumulates a lot
 * of events, and this runs on every dashboard load.
 */
export async function videoPerformance(
  shopId: string,
  since: Date,
): Promise<VideoPerformance[]> {
  const rows = await prisma.videoEvent.groupBy({
    by: ["videoId", "type"],
    where: { shopId, occurredAt: { gte: since }, videoId: { not: null } },
    _count: { _all: true },
    _sum: { value: true },
  });

  const byVideo = new Map<string, VideoPerformance>();

  for (const row of rows) {
    if (!row.videoId) continue;
    const entry =
      byVideo.get(row.videoId) ??
      ({
        videoId: row.videoId,
        title: "",
        posterUrl: null,
        impressions: 0,
        views: 0,
        clicks: 0,
        addToCarts: 0,
        orders: 0,
        revenue: 0,
      } satisfies VideoPerformance);

    const count = row._count._all;
    switch (row.type) {
      case EventType.IMPRESSION:
        entry.impressions += count;
        break;
      case EventType.VIEW_START:
        entry.views += count;
        break;
      case EventType.PRODUCT_CLICK:
        entry.clicks += count;
        break;
      case EventType.ADD_TO_CART:
        entry.addToCarts += count;
        break;
      case EventType.PURCHASE:
        entry.orders += count;
        entry.revenue += Number(row._sum.value ?? 0);
        break;
      default:
        break;
    }
    byVideo.set(row.videoId, entry);
  }

  if (byVideo.size === 0) return [];

  const videos = await prisma.video.findMany({
    where: { id: { in: [...byVideo.keys()] } },
    select: { id: true, title: true, posterUrl: true },
  });
  for (const video of videos) {
    const entry = byVideo.get(video.id);
    if (entry) {
      entry.title = video.title ?? "Untitled";
      entry.posterUrl = video.posterUrl;
    }
  }

  return [...byVideo.values()].sort((a, b) => b.revenue - a.revenue || b.views - a.views);
}
