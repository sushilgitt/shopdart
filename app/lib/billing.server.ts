import { Plan } from "@prisma/client";
import prisma from "../db.server";

/**
 * Shopify App Pricing (formerly Managed Pricing).
 *
 * Plans live in the Partner dashboard, not in code, and Shopify hosts the
 * selection page, handles trials, proration and invoicing. The legacy Billing
 * API — appSubscriptionCreate and friends — is not used: it is legacy for new
 * apps, and it would mean reimplementing all of that ourselves.
 *
 * Our only jobs are to send merchants to the hosted page and to record which
 * plan came back.
 */

/**
 * Maps a Partner-dashboard plan handle onto our Plan enum.
 *
 * These handles must match what is configured in the Partner dashboard
 * exactly. A handle we don't recognise falls back to FREE rather than
 * throwing — the merchant is mid-flow and locking them out over a naming
 * mismatch would be worse than under-serving briefly.
 */
const HANDLE_TO_PLAN: Record<string, Plan> = {
  free: Plan.FREE,
  basic: Plan.BASIC,
  premium: Plan.PREMIUM,
  elite: Plan.ELITE,
};

export function planFromHandle(handle: string | null): Plan | null {
  if (!handle) return null;
  return HANDLE_TO_PLAN[handle.trim().toLowerCase()] ?? null;
}

/** App handle from shopify.app.toml. Part of the hosted pricing URL. */
const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "shopdart";

/**
 * URL of Shopify's hosted plan selection page.
 *
 * Must be opened at the top level — it is admin UI and will not render inside
 * the embedded app frame.
 */
export function pricingPageUrl(shopDomain: string): string {
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;
}

/**
 * Persists the plan Shopify reports after a selection.
 *
 * Called from the app root loader, because Shopify appends `plan_handle` to
 * whatever redirect URL is configured and the merchant may land anywhere in
 * the app.
 */
export async function applyPlanHandle(
  shopDomain: string,
  handle: string | null,
): Promise<Plan | null> {
  const plan = planFromHandle(handle);
  if (!plan) return null;

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, plan: true },
  });
  if (!shop || shop.plan === plan) return plan;

  await prisma.shop.update({
    where: { id: shop.id },
    data: { plan, planUpdatedAt: new Date() },
  });

  return plan;
}
