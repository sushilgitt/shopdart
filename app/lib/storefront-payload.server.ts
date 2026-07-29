import prisma from "../db.server";
import { parseConfig, type WidgetConfig, type WidgetLayout, type PlacementTarget } from "./widget-config";

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
  poster: string | null;
  /** Progressive MP4 — preferred for short clips. */
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
    select: { id: true, domain: true, uninstalledAt: true },
  });

  // Serve an empty payload rather than 404 for uninstalled shops: a theme may
  // still contain the block, and an error there is noisier than nothing.
  if (!shop || shop.uninstalledAt) {
    return { shop: shopDomain, generatedAt: new Date().toISOString(), widgets: [] };
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
