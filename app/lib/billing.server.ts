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
 * Our jobs are to send merchants to the hosted page and to record which plan
 * they are actually on. "Actually" is load-bearing: Shopify appends
 * `plan_handle` to the redirect after a selection, and trusting it meant
 * visiting /app?plan_handle=elite granted Elite limits with no subscription
 * behind them. A query parameter is user-supplied input, not proof of payment.
 * The plan is now read from the active subscription on the app installation,
 * which only Shopify can set.
 */

/**
 * Maps a Shopify App Pricing plan onto our Plan enum.
 *
 * Keyed on the plan HANDLE, which is the stable identifier configured in the
 * Partner dashboard. The display name is accepted as a fallback for
 * subscriptions that predate managed pricing or otherwise carry no handle.
 *
 * Preferring the handle matters: the name is merchant-facing and localisable,
 * so renaming "Basic" in the dashboard would silently drop every Basic
 * subscriber to FREE limits while they carried on paying. The handle does not
 * change when the display name does.
 *
 * An identifier we don't recognise falls back to FREE rather than throwing —
 * under-serving a merchant briefly is better than locking them out of the app
 * over a naming mismatch.
 */
const PLAN_BY_IDENTIFIER: Record<string, Plan> = {
  free: Plan.FREE,
  basic: Plan.BASIC,
  premium: Plan.PREMIUM,
  elite: Plan.ELITE,
};

export function planFromIdentifier(
  identifier: string | null | undefined,
): Plan | null {
  if (!identifier) return null;
  return PLAN_BY_IDENTIFIER[identifier.trim().toLowerCase()] ?? null;
}

const PLAN_RANK: Record<Plan, number> = {
  [Plan.FREE]: 0,
  [Plan.BASIC]: 1,
  [Plan.PREMIUM]: 2,
  [Plan.ELITE]: 3,
};

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
 * planHandle lives on AppRecurringPricing, reached through the pricingDetails
 * union on each line item — it is not a field on the subscription itself.
 * Available from API version 2025-04.
 */
const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query shopdartActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        lineItems {
          plan {
            pricingDetails {
              ... on AppRecurringPricing {
                planHandle
              }
            }
          }
        }
      }
    }
  }
`;

interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  lineItems?: {
    plan?: { pricingDetails?: { planHandle?: string | null } | null } | null;
  }[];
}

interface SubscriptionsResponse {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: ActiveSubscription[];
    };
  };
}

/** First plan handle on the subscription, if it carries one. */
function handleOf(subscription: ActiveSubscription): string | null {
  for (const lineItem of subscription.lineItems ?? []) {
    const handle = lineItem?.plan?.pricingDetails?.planHandle;
    if (handle) return handle;
  }
  return null;
}

/** The slice of the Admin API client this module needs. */
interface AdminGraphql {
  graphql: (query: string) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * Reconciles the stored plan with the merchant's real subscription.
 *
 * Runs on every admin load rather than only after a plan change, so a
 * cancellation, downgrade or failed payment takes effect without the merchant
 * having to pass back through the pricing page. No active subscription means
 * FREE, which is also where a cancelled or expired one lands.
 *
 * Returns null when Shopify could not be reached. Callers keep serving the
 * stored plan in that case: a transient API error must never silently demote a
 * paying merchant.
 */
export async function syncPlanFromShopify(
  admin: AdminGraphql,
  shopDomain: string,
): Promise<Plan | null> {
  let subscriptions: ActiveSubscription[];

  try {
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    const body = (await response.json()) as SubscriptionsResponse;
    subscriptions =
      body?.data?.currentAppInstallation?.activeSubscriptions ?? [];
  } catch (error) {
    console.error(`Could not read subscriptions for ${shopDomain}`, error);
    return null;
  }

  // Test subscriptions are how development stores exercise billing, so they
  // count. Anything not ACTIVE — frozen, cancelled, pending — does not.
  const active = subscriptions.filter(
    (subscription) => subscription.status?.toUpperCase() === "ACTIVE",
  );

  // A merchant should never be worse off for somehow holding two active
  // subscriptions, so the most generous one wins.
  const plan =
    active
      .map(
        (subscription) =>
          // Handle first: it survives a rename in the Partner dashboard,
          // whereas the display name does not.
          planFromIdentifier(handleOf(subscription)) ??
          planFromIdentifier(subscription.name),
      )
      .filter((value): value is Plan => value !== null)
      .sort((a, b) => PLAN_RANK[b] - PLAN_RANK[a])[0] ?? Plan.FREE;

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, plan: true },
  });
  if (!shop) return plan;

  if (shop.plan !== plan) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { plan, planUpdatedAt: new Date() },
    });
    console.log(`Plan for ${shopDomain}: ${shop.plan} -> ${plan}`);
  }

  return plan;
}
