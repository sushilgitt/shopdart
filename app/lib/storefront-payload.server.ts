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
   * Free plan shows a small "Powered by DPS" badge. This is the concrete
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
   * <video>; `youtube` and `tiktok` videos are embedded in that platform's own
   * iframe player, because neither permits re-hosting the file — YouTube by
   * their terms, TikTok by returning no file from any API at all.
   *
   * An embed is the weaker tier: it cannot force autoplay, and it renders
   * nothing in a country where that platform is blocked. A merchant who
   * supplies their own file is upgraded to `bunny` automatically.
   *
   * Older cached payloads predate this field, so the player must treat a
   * missing value as `bunny`.
   */
  provider: "bunny" | "youtube" | "tiktok";
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

export interface StorefrontVariant {
  /** Numeric variant id, ready for the Cart Ajax API. */
  id: string;
  title: string;
  price: number | null;
  available: boolean;
}

export interface StorefrontProduct {
  id: string;
  /** Numeric variant id, ready for the Cart Ajax API. Null when the shopper must choose. */
  variantId: string | null;
  /**
   * Every buyable variant, so the player can offer a picker in place of
   * sending the shopper to the product page. Empty for tags created before
   * variants were cached — the player falls back to a link in that case.
   */
  variants: StorefrontVariant[];
  handle: string | null;
  title: string;
  image: string | null;
  price: number | null;
  /** Seconds. Null means the product shows for the whole clip. */
  from: number | null;
  to: number | null;
}

/**
 * How the player should play this video.
 *
 * Derived from whether we hold the file, not from where the video came from.
 * `source` records provenance — that the merchant found this clip on TikTok,
 * say — while the provider answers a different question: is there a file on
 * our own CDN to point a <video> at?
 *
 * Those two diverge the moment a source can arrive by more than one route. A
 * TikTok post the merchant uploaded the original file for is, to the player,
 * an ordinary hosted video; keying playback off `source` would publish it as
 * an embed carrying no embed id, and the storefront would render nothing.
 */
function providerFor(video: {
  bunnyVideoId: string | null;
  source: string;
}): "bunny" | "youtube" | "tiktok" {
  // A file we hold always wins. A TikTok post the merchant uploaded the
  // original for is, to the player, an ordinary hosted video — and a better
  // one than the embed, because it autoplays and does not depend on TikTok
  // being reachable from the shopper's country.
  if (video.bunnyVideoId) return "bunny";
  if (video.source === "YOUTUBE") return "youtube";
  if (video.source === "TIKTOK") return "tiktok";
  return "bunny";
}

/**
 * Where the player should fetch a video's poster.
 *
 * Hosted videos already point at our own Bunny CDN. TikTok covers do not: they
 * live on tiktokcdn hosts that are unreachable wherever TikTok is blocked, and
 * they carry a signed `x-expires` that outlives nothing. Both failures render
 * as a black rectangle on the storefront, and the poster is exactly what the
 * embed's fallback depends on being there.
 *
 * Routing them through /img/tiktok/{id} moves the problem to a server that can
 * reach TikTok and can refresh an expired signature. Falls back to the raw URL
 * when the app origin is unknown, which only happens outside a deployment.
 */
function posterFor(
  video: { id: string; posterUrl: string | null },
  provider: "bunny" | "youtube" | "tiktok",
): string | null {
  if (provider !== "tiktok") return video.posterUrl;
  const raw = process.env.SHOPIFY_APP_URL ?? "";
  const origin = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!origin) return video.posterUrl;
  return `${origin}/img/tiktok/${video.id}`;
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
            provider: providerFor(entry.video),
            // Only an embed needs a provider-side id; a hosted video is played
            // from mp4/hls and has none.
            embedId:
              providerFor(entry.video) === "bunny"
                ? null
                : entry.video.sourceRef,
            poster: posterFor(entry.video, providerFor(entry.video)),
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
              variants: Array.isArray(tag.variants)
                ? (tag.variants as unknown as StorefrontVariant[]).filter(
                    (variant) => variant?.id,
                  )
                : [],
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
