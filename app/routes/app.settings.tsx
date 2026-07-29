import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { PLANS, PLAN_ORDER } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  return {
    shopDomain: shop.domain,
    currentPlan: shop.plan,
    instagramConnected: Boolean(shop.igUserId),
    igUsername: shop.igUsername,
    plans: PLAN_ORDER.map((id) => PLANS[id]),
  };
};

export default function Settings() {
  const { shopDomain, currentPlan, instagramConnected, igUsername, plans } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Plan">
        <s-stack direction="block" gap="base">
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
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
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
                    </s-text>
                    <s-text color="subdued">{plan.features.join(" · ")}</s-text>
                  </s-stack>
                  {!active && (
                    <s-button disabled variant="secondary">
                      Choose
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="Instagram">
        {instagramConnected ? (
          <s-paragraph>
            Connected as <s-text type="strong">@{igUsername}</s-text>. New
            reels sync automatically once a day.
          </s-paragraph>
        ) : (
          <>
            <s-paragraph>
              Connect an Instagram Business or Creator account to bring your own
              reels into Shopdart. Shopdart only reads media from the account you
              authorise.
            </s-paragraph>
            <s-button disabled variant="secondary">
              Connect Instagram
            </s-button>
          </>
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
