import prisma from "../db.server";
import { planFor } from "./plans";
import {
  parseConfig,
  type PlacementTarget,
  type WidgetConfig,
  type WidgetLayout,
} from "./widget-config";

/**
 * The payload the storefront player consumes.
 *
 * This is a public document served to every shopper, so it must contain only
 * what the player needs to render and nothing about the merchant's account.
 * It is also the contract with the theme extension — adding fields is safe,
 * renaming or removing them breaks storefronts still running a cached copy of
 * the old script.
 */
export interface StorefrontPayload {
  shop: string;
  generatedAt: string;
  /** ISO currency of the store, so the player formats prices correctly. */
  currency: string | null;
  /**
   * Free plan shows a small "Powered by Shopdart" badge. This is the concrete
   * reason to upgrade to Basic, so it has to actually render.
   */
  watermark: boolean;
  widgets: StorefrontWidget[];
}

export interface StorefrontWidget {
  id: string;
  layout: WidgetLayout;
  version: number;
  config: WidgetConfig;
  placements: { target: PlacementTarget; ref: string | null }[];
  videos: StorefrontVideo[];
}

export interface StorefrontVideo {
  id: string;
  title: string;
  /**
   * Which player to use. `bunny` videos are files we host and play in a plain
   * <video>; `youtube` videos are embedded in YouTube's iframe player, because
   * their terms do not permit re-hosting the file.
   *
   * Older cached payloads predate this field, so the player must treat a
   * missing value as `bunny`.
   */
  provider: "bunny" | "youtube";
  /** Provider-side id — the YouTube video id. Null for hosted videos. */
  embedId: string | null;
  poster: string | null;
  /** Progressive MP4 — preferred for short clips. Null for embeds. */
  mp4: string | null;
  /** HLS, used only for longer videos where ABR earns its bytes. */
  hls: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  products: StorefrontProduct[];
}

export interface StorefrontProduct {
  id: string;
  /** Numeric variant id, ready for the Cart Ajax API. Null when the shopper must choose. */
  variantId: string | null;
  handle: string | null;
  title: string;
  image: string | null;
  price: number | null;
  /** Seconds. Null means the product shows for the whole clip. */
  from: number | null;
  to: number | null;
}

/**
 * Builds the payload for one shop.
 *
 * Every published widget for the shop is returned in a single document rather
 * than one request per page type. It is a small file, it caches once for the
 * whole site, and it avoids a per-page-type cache explosion. The player picks
 * which widgets apply to the page it is on.
 */
export async function buildStorefrontPayload(
  shopDomain: string,
): Promise<StorefrontPayload | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: {
      id: true,
      domain: true,
      uninstalledAt: true,
      plan: true,
      currencyCode: true,
    },
  });

  // Serve an empty payload rather than 404 for uninstalled shops: a theme may
  // still contain the block, and an error there is noisier than nothing.
  if (!shop || shop.uninstalledAt) {
    return {
      shop: shopDomain,
      generatedAt: new Date().toISOString(),
      currency: null,
      watermark: false,
      widgets: [],
    };
  }

  const widgets = await prisma.widget.findMany({
    where: { shopId: shop.id, status: "PUBLISHED" },
    include: {
      placements: true,
      videos: {
        orderBy: { position: "asc" },
        include: {
          video: {
            include: { tags: { orderBy: { position: "asc" } } },
          },
        },
      },
    },
  });

  return {
    shop: shop.domain,
    generatedAt: new Date().toISOString(),
    currency: shop.currencyCode,
    watermark: planFor(shop.plan).watermark,
    widgets: widgets
      .map((widget) => ({
        id: widget.id,
        layout: widget.layout as WidgetLayout,
        version: widget.configVersion,
        config: parseConfig(widget.config, widget.layout as WidgetLayout),
        placements: widget.placements.map((placement) => ({
          target: placement.target as PlacementTarget,
          ref: placement.targetRef,
        })),
        videos: widget.videos
          // A video still encoding would render a broken player.
          .filter((entry) => entry.video.status === "READY" && !entry.video.archivedAt)
          .map((entry) => ({
            id: entry.video.id,
            title: entry.video.title ?? "",
            provider: (entry.video.source === "YOUTUBE"
              ? "youtube"
              : "bunny") as "bunny" | "youtube",
            embedId:
              entry.video.source === "YOUTUBE" ? entry.video.sourceRef : null,
            poster: entry.video.posterUrl,
            mp4: entry.video.mp4Url,
            hls: entry.video.hlsUrl,
            duration: entry.video.durationSec,
            width: entry.video.width,
            height: entry.video.height,
            products: entry.video.tags.map((tag) => ({
              id: tag.productGid,
              // The Ajax cart wants the bare numeric id, not the gid.
              variantId: tag.variantGid
                ? tag.variantGid.split("/").pop() ?? null
                : null,
              handle: tag.handle,
              title: tag.title ?? "",
              image: tag.imageUrl,
              price: tag.priceAmount ? Number(tag.priceAmount) : null,
              from: tag.startSec,
              to: tag.endSec,
            })),
          })),
      }))
      // Drop widgets with nothing playable — the player would render an empty
      // container and shift the page for no reason.
      .filter((widget) => widget.videos.length > 0),
  };
}
