/**
 * Shared between the admin UI and the server, so this module must stay free of
 * server-only imports — including `@prisma/client`, which would otherwise be
 * pulled into the browser bundle. The string unions below mirror the Prisma
 * enums exactly; the server casts across the boundary.
 */
export type WidgetLayout =
  | "GALLERY"
  | "CAROUSEL"
  | "STORIES"
  | "FLOATING"
  | "PRODUCT_PAGE"
  | "POPUP";

export type PlacementTarget =
  | "HOME"
  | "PRODUCT"
  | "COLLECTION"
  | "CART"
  | "ALL_PAGES"
  | "CUSTOM";

/**
 * Presentation settings for a widget.
 *
 * This is the shape stored in `Widget.config` and published verbatim to the
 * CDN, so the storefront player reads it directly. Keep it flat and
 * serialisable — no dates, no nested classes — and treat every field as
 * optional when reading, because payloads written by older app versions stay
 * cached on the edge for a while after a deploy.
 */
export interface WidgetConfig {
  /** Optional heading rendered above the widget. */
  heading: string;
  /** Accent used for the CTA button and progress bar. */
  accentColor: string;
  /** Text colour on the accent. */
  accentTextColor: string;
  cornerRadius: number;
  aspectRatio: AspectRatio;
  /** Gallery and carousel only. */
  itemsPerRow: number;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  showCaption: boolean;
  /** Product card overlaid inside the player. */
  showProductCard: boolean;
  ctaLabel: string;
  /** Floating layout only. */
  position: FloatingPosition;
}

export type AspectRatio = "9:16" | "4:5" | "1:1" | "16:9";
export type FloatingPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

export const ASPECT_RATIOS: AspectRatio[] = ["9:16", "4:5", "1:1", "16:9"];

export const LAYOUTS: {
  id: WidgetLayout;
  name: string;
  detail: string;
}[] = [
  {
    id: "CAROUSEL",
    name: "Carousel",
    detail: "A horizontal row shoppers swipe through.",
  },
  {
    id: "GALLERY",
    name: "Video gallery",
    detail: "A grid of videos on any page.",
  },
  {
    id: "STORIES",
    name: "Stories",
    detail: "Tappable circles in a bar, like Instagram.",
  },
  {
    id: "PRODUCT_PAGE",
    name: "Product page",
    detail: "Videos featuring the product being viewed.",
  },
  {
    id: "FLOATING",
    name: "Floating video",
    detail: "A small player pinned to a corner of the page.",
  },
  {
    id: "POPUP",
    name: "Popup",
    detail: "A full-screen player opened on click.",
  },
];

const BASE: WidgetConfig = {
  heading: "",
  accentColor: "#111827",
  accentTextColor: "#ffffff",
  cornerRadius: 12,
  // Vertical by default: the source material is reels, and letterboxing a
  // 9:16 clip into a 16:9 frame wastes most of the pixels.
  aspectRatio: "9:16",
  itemsPerRow: 4,
  autoplay: true,
  // Autoplay only survives browser policy while muted. Unmuting by default
  // gets the video blocked outright, not merely silenced.
  muted: true,
  loop: true,
  showCaption: false,
  showProductCard: true,
  ctaLabel: "Shop now",
  position: "bottom-right",
};

const PER_LAYOUT: Partial<Record<WidgetLayout, Partial<WidgetConfig>>> = {
  ["GALLERY"]: { itemsPerRow: 4, heading: "Shop the look" },
  ["CAROUSEL"]: { itemsPerRow: 5, heading: "Shop our videos" },
  ["STORIES"]: {
    aspectRatio: "1:1",
    itemsPerRow: 8,
    cornerRadius: 999,
    showProductCard: true,
  },
  ["PRODUCT_PAGE"]: { itemsPerRow: 3, heading: "See it in action" },
  ["FLOATING"]: {
    itemsPerRow: 1,
    cornerRadius: 16,
    showProductCard: true,
  },
  ["POPUP"]: { itemsPerRow: 1, showCaption: true },
};

export function defaultConfig(layout: WidgetLayout): WidgetConfig {
  return { ...BASE, ...(PER_LAYOUT[layout] ?? {}) };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Coerces stored or submitted JSON into a complete config.
 *
 * Always returns every field. The storefront player should never have to
 * null-check a setting, and a widget saved by an older version of the app must
 * keep rendering after a deploy adds new fields.
 */
export function parseConfig(
  raw: unknown,
  layout: WidgetLayout = "CAROUSEL",
): WidgetConfig {
  const defaults = defaultConfig(layout);
  if (!raw || typeof raw !== "object") return defaults;
  const input = raw as Record<string, unknown>;

  const str = (key: keyof WidgetConfig, fallback: string) =>
    typeof input[key] === "string" ? (input[key] as string) : fallback;
  const bool = (key: keyof WidgetConfig, fallback: boolean) =>
    typeof input[key] === "boolean" ? (input[key] as boolean) : fallback;
  const num = (key: keyof WidgetConfig, fallback: number, min: number, max: number) => {
    const value = Number(input[key]);
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  };

  const accentColor = str("accentColor", defaults.accentColor);
  const accentTextColor = str("accentTextColor", defaults.accentTextColor);
  const aspectRatio = str("aspectRatio", defaults.aspectRatio) as AspectRatio;
  const position = str("position", defaults.position) as FloatingPosition;

  return {
    heading: str("heading", defaults.heading).slice(0, 120),
    // Reject anything that isn't a plain hex colour — this value is
    // interpolated into storefront CSS.
    accentColor: HEX.test(accentColor) ? accentColor : defaults.accentColor,
    accentTextColor: HEX.test(accentTextColor)
      ? accentTextColor
      : defaults.accentTextColor,
    cornerRadius: num("cornerRadius", defaults.cornerRadius, 0, 999),
    aspectRatio: ASPECT_RATIOS.includes(aspectRatio)
      ? aspectRatio
      : defaults.aspectRatio,
    itemsPerRow: num("itemsPerRow", defaults.itemsPerRow, 1, 8),
    autoplay: bool("autoplay", defaults.autoplay),
    muted: bool("muted", defaults.muted),
    loop: bool("loop", defaults.loop),
    showCaption: bool("showCaption", defaults.showCaption),
    showProductCard: bool("showProductCard", defaults.showProductCard),
    ctaLabel: str("ctaLabel", defaults.ctaLabel).slice(0, 40) || "Shop now",
    position: (
      ["bottom-right", "bottom-left", "top-right", "top-left"] as string[]
    ).includes(position)
      ? position
      : defaults.position,
  };
}

export function layoutName(layout: WidgetLayout): string {
  return LAYOUTS.find((entry) => entry.id === layout)?.name ?? String(layout);
}

export const PLACEMENT_TARGETS: {
  id: PlacementTarget;
  name: string;
  detail: string;
}[] = [
  { id: "HOME", name: "Home page", detail: "Your storefront home page." },
  {
    id: "PRODUCT",
    name: "Product pages",
    detail: "Every product page, or one specific product.",
  },
  {
    id: "COLLECTION",
    name: "Collection pages",
    detail: "Category and collection listings.",
  },
  { id: "CART", name: "Cart", detail: "The cart page." },
  {
    id: "ALL_PAGES",
    name: "Every page",
    detail: "Best paired with the floating layout.",
  },
];
