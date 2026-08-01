import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { PLANS, PLAN_ORDER, currentPeriod, planFor } from "../lib/plans";
import { pricingPageUrl } from "../lib/billing.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const usage = await prisma.usageCounter.findUnique({
    where: { shopId_period: { shopId: shop.id, period: currentPeriod() } },
  });

  const plan = planFor(shop.plan);

  return {
    shopDomain: shop.domain,
    currentPlan: shop.plan as string,
    pricingUrl: pricingPageUrl(shop.domain),
    instagramConnected: Boolean(shop.igUserId),
    igUsername: shop.igUsername,
    plans: PLAN_ORDER.map((id) => PLANS[id]),
    usage: {
      views: usage?.views ?? 0,
      limit: plan.views,
      capReached: Boolean(usage?.capReachedAt),
    },
  };
};

export default function Settings() {
  const {
    shopDomain,
    currentPlan,
    pricingUrl,
    instagramConnected,
    igUsername,
    plans,
    usage,
  } = useLoaderData<typeof loader>();

  const pct =
    usage.limit > 0
      ? Math.min(100, Math.round((usage.views / usage.limit) * 100))
      : 0;

  // Shopify's hosted pricing page is admin UI and will not render inside the
  // embedded app frame, so it has to be opened at the top level.
  const openPricing = () => {
    window.open(pricingUrl, "_top");
  };

  return (
    <s-page heading="Settings">
      {usage.capReached && (
        <s-section heading="You've reached this month's view limit">
          <s-paragraph>
            Your videos are still playing — we don&rsquo;t switch off a live
            storefront over billing. Views past the limit simply stop counting
            until your next billing period.
          </s-paragraph>
          <s-button onClick={openPricing}>Upgrade plan</s-button>
        </s-section>
      )}

      <s-section heading="Plan">
        <s-paragraph>
          <s-text type="strong">{usage.views.toLocaleString()}</s-text>
          <s-text color="subdued">
            {" "}
            of {usage.limit.toLocaleString()} monthly views used ({pct}%)
          </s-text>
        </s-paragraph>

        <s-stack direction="block" gap="small-200">
          {plans.map((plan) => {
            const active = plan.id === currentPlan;
            return (
              <s-box
                key={plan.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background={active ? "subdued" : undefined}
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">
                    {plan.name}
                    {active ? " — current plan" : ""}
                  </s-text>
                  <s-text color="subdued">
                    {plan.price === 0
                      ? "Free"
                      : `$${plan.price.toFixed(2)}/month`}{" "}
                    · {plan.views.toLocaleString()} views ·{" "}
                    {plan.videos.toLocaleString()} videos
                    {plan.trialDays > 0 ? ` · ${plan.trialDays}-day trial` : ""}
                  </s-text>
                  <s-text color="subdued">{plan.features.join(" · ")}</s-text>
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>

        <s-paragraph>
          <s-text color="subdued">
            Plans, trials and invoices are handled by Shopify. Changes appear
            here as soon as you come back.
          </s-text>
        </s-paragraph>
        <s-button onClick={openPricing}>Change plan</s-button>
      </s-section>

      <s-section heading="Instagram">
        {instagramConnected ? (
          <s-paragraph>
            Connected as <s-text type="strong">@{igUsername}</s-text>. Import
            new reels from the <s-link href="/app/instagram">Instagram</s-link>{" "}
            tab.
          </s-paragraph>
        ) : (
          <s-paragraph>
            Not connected.{" "}
            <s-link href="/app/instagram">Connect an account</s-link> to import
            your reels.
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Store">
        <s-paragraph>
          <s-text color="subdued">{shopDomain}</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
