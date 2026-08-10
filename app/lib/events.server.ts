import { createHash } from "node:crypto";
import { EventType, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { recordPurchase } from "./attribution.server";
import { currentPeriod, planFor } from "./plans";

/**
 * Storefront event ingest.
 *
 * Metering runs off this, which makes correctness here a billing question, not
 * an analytics one. Two safeguards matter:
 *
 *  - Bots are dropped before anything is counted. Crawlers, preview fetchers
 *    and uptime monitors otherwise inflate view counts, push merchants over a
 *    plan cap they did not earn, and produce exactly the one-star reviews this
 *    category is decided by.
 *  - Views are deduped per session per video. A shopper scrolling a carousel
 *    back and forth is one view, not six.
 */

const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|discord|slack|preview|monitor|pingdom|uptime|lighthouse|headless|phantom|puppeteer|playwright|curl|wget|python-requests|axios|go-http/i;

/** Events that count against the plan's monthly view allowance. */
const METERED: EventType[] = [EventType.VIEW_START];

/** Events deduped to one per session per video. */
const DEDUPED: EventType[] = [EventType.IMPRESSION, EventType.VIEW_START];

export interface IncomingEvent {
  type: string;
  widgetId?: string;
  videoId?: string;
  productId?: string;
  /** Opaque client-generated session id. Hashed before storage. */
  session?: string;
  /** PURCHASE only, sent by the web pixel. */
  orderGid?: string;
  value?: number;
  currency?: string;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
}

export function isBot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.trim().length < 8) return true;
  return BOT_PATTERN.test(userAgent);
}

/**
 * Hashes the client session id with the app secret.
 *
 * The raw value never reaches the database — it is only ever needed for
 * equality comparison, so there is no reason to keep it in a form that could
 * be correlated back to a shopper if the table leaked.
 */
function hashSession(raw: string): string {
  const salt = process.env.SHOPIFY_API_SECRET ?? "shopdart";
  return createHash("sha256").update(`${salt}:${raw}`).digest("hex").slice(0, 40);
}

function toEventType(value: string): EventType | null {
  const upper = value.toUpperCase();
  return (Object.values(EventType) as string[]).includes(upper)
    ? (upper as EventType)
    : null;
}

export async function ingestEvents(
  shopDomain: string,
  events: IncomingEvent[],
  userAgent: string | null,
): Promise<IngestResult> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, plan: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) {
    return { accepted: 0, rejected: events.length };
  }

  // Purchases are split out before anything else. They arrive from the web
  // pixel's checkout_completed event, carry a real order id, and are written
  // through the same path as the orders/create webhook so the two can never
  // disagree.
  //
  // They also skip the bot filter deliberately. That filter exists to stop
  // crawler traffic inflating metered views; a completed order is not
  // speculative traffic, and dropping one because a headless-looking user agent
  // reached the thank-you page would under-report real revenue — the failure
  // mode a merchant notices immediately.
  const purchases = events.filter(
    (event) => toEventType(event.type ?? "") === EventType.PURCHASE,
  );
  const behaviour = events.filter(
    (event) => toEventType(event.type ?? "") !== EventType.PURCHASE,
  );

  let purchasesAccepted = 0;
  let purchasesRejected = 0;

  for (const event of purchases) {
    if (!event.videoId || !event.orderGid) {
      purchasesRejected += 1;
      continue;
    }
    const value = Number(event.value);
    const recorded = await recordPurchase(shop.id, {
      videoId: event.videoId,
      widgetId: event.widgetId ?? null,
      sessionKey: event.session ? hashSession(event.session) : null,
      orderGid: event.orderGid,
      value: Number.isFinite(value) ? value : 0,
      currencyCode: event.currency ?? null,
    });
    if (recorded) purchasesAccepted += 1;
    else purchasesRejected += 1;
  }

  if (behaviour.length === 0) {
    return { accepted: purchasesAccepted, rejected: purchasesRejected };
  }

  if (isBot(userAgent)) {
    return {
      accepted: purchasesAccepted,
      rejected: purchasesRejected + behaviour.length,
    };
  }

  // Only accept ids that belong to this shop. Without this check anyone could
  // POST another merchant's video id and pollute their analytics.
  const [videoIds, widgetIds] = await Promise.all([
    prisma.video
      .findMany({
        where: {
          shopId: shop.id,
          id: {
            in: behaviour.map((e) => e.videoId).filter(Boolean) as string[],
          },
        },
        select: { id: true },
      })
      .then((rows) => new Set(rows.map((r) => r.id))),
    prisma.widget
      .findMany({
        where: {
          shopId: shop.id,
          id: {
            in: behaviour.map((e) => e.widgetId).filter(Boolean) as string[],
          },
        },
        select: { id: true },
      })
      .then((rows) => new Set(rows.map((r) => r.id))),
  ]);

  const rows: Prisma.VideoEventCreateManyInput[] = [];
  let rejected = purchasesRejected;

  for (const event of behaviour) {
    const type = toEventType(event.type ?? "");
    if (!type || !event.session) {
      rejected += 1;
      continue;
    }
    if (event.videoId && !videoIds.has(event.videoId)) {
      rejected += 1;
      continue;
    }
    if (event.widgetId && !widgetIds.has(event.widgetId)) {
      rejected += 1;
      continue;
    }

    rows.push({
      shopId: shop.id,
      videoId: event.videoId ?? null,
      widgetId: event.widgetId ?? null,
      type,
      sessionKey: hashSession(event.session),
      productGid: event.productId ?? null,
    });
  }

  if (rows.length === 0) {
    return { accepted: purchasesAccepted, rejected };
  }

  // Drop repeats of deduped types this session has already sent.
  const dedupeCandidates = rows.filter((row) => DEDUPED.includes(row.type));
  const alreadySeen = new Set<string>();

  if (dedupeCandidates.length > 0) {
    const existing = await prisma.videoEvent.findMany({
      where: {
        shopId: shop.id,
        type: { in: DEDUPED },
        sessionKey: { in: dedupeCandidates.map((row) => row.sessionKey) },
        videoId: {
          in: dedupeCandidates
            .map((row) => row.videoId)
            .filter(Boolean) as string[],
        },
      },
      select: { sessionKey: true, videoId: true, type: true },
    });
    for (const row of existing) {
      alreadySeen.add(`${row.sessionKey}:${row.videoId}:${row.type}`);
    }
  }

  const seenInBatch = new Set<string>();
  const fresh = rows.filter((row) => {
    if (!DEDUPED.includes(row.type)) return true;
    const key = `${row.sessionKey}:${row.videoId}:${row.type}`;
    if (alreadySeen.has(key) || seenInBatch.has(key)) return false;
    seenInBatch.add(key);
    return true;
  });

  if (fresh.length === 0) {
    return {
      accepted: purchasesAccepted,
      rejected: rejected + rows.length,
    };
  }

  await prisma.videoEvent.createMany({ data: fresh, skipDuplicates: true });

  await rollUp(shop.id, shop.plan, fresh);

  return {
    accepted: purchasesAccepted + fresh.length,
    rejected: rejected + (rows.length - fresh.length),
  };
}

/** Folds a batch into the monthly counter, which is what billing reads. */
async function rollUp(
  shopId: string,
  plan: Parameters<typeof planFor>[0],
  events: Prisma.VideoEventCreateManyInput[],
): Promise<void> {
  const period = currentPeriod();
  const delta = {
    impressions: 0,
    views: 0,
    clicks: 0,
    addToCarts: 0,
  };

  for (const event of events) {
    switch (event.type) {
      case EventType.IMPRESSION:
        delta.impressions += 1;
        break;
      case EventType.VIEW_START:
        delta.views += 1;
        break;
      case EventType.PRODUCT_CLICK:
        delta.clicks += 1;
        break;
      case EventType.ADD_TO_CART:
        delta.addToCarts += 1;
        break;
      default:
        break;
    }
  }

  const counter = await prisma.usageCounter.upsert({
    where: { shopId_period: { shopId, period } },
    create: { shopId, period, ...delta },
    update: {
      impressions: { increment: delta.impressions },
      views: { increment: delta.views },
      clicks: { increment: delta.clicks },
      addToCarts: { increment: delta.addToCarts },
    },
  });

  // Record the moment the cap was crossed so the merchant is told once,
  // rather than every request for the rest of the month.
  const limit = planFor(plan).views;
  if (counter.views >= limit && !counter.capReachedAt) {
    await prisma.usageCounter.update({
      where: { id: counter.id },
      data: { capReachedAt: new Date() },
    });
  }
}

export { METERED };
