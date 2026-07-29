import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { currentPeriod } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const counters = await prisma.usageCounter.findMany({
    where: { shopId: shop.id },
    orderBy: { period: "desc" },
    take: 12,
  });

  return {
    period: currentPeriod(),
    counters: counters.map((counter) => ({
      period: counter.period,
      impressions: counter.impressions,
      views: counter.views,
      clicks: counter.clicks,
      addToCarts: counter.addToCarts,
      orders: counter.orders,
      revenue: Number(counter.revenue),
    })),
  };
};

export default function Analytics() {
  const { counters } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Analytics">
      {counters.length === 0 ? (
        <s-section heading="Nothing to report yet">
          <s-paragraph>
            Once your first widget is live, this is where you will see which
            videos earn their place — views, product clicks, add-to-carts, and
            the revenue each video actually drove.
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              Revenue is matched to orders through cart attributes and the order
              webhook, so a sale is attributed to the video that caused it rather
              than estimated.
            </s-text>
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Monthly performance">
          <s-stack direction="block" gap="base">
            {counters.map((counter) => (
              <s-box
                key={counter.period}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{counter.period}</s-text>
                  <s-text color="subdued">
                    {counter.views.toLocaleString()} views ·{" "}
                    {counter.clicks.toLocaleString()} clicks ·{" "}
                    {counter.addToCarts.toLocaleString()} add-to-cart ·{" "}
                    {counter.orders.toLocaleString()} orders
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="What gets counted">
        <s-paragraph>
          <s-text color="subdued">
            A view is one playback per shopper session, per video. Repeat
            impressions and known bots are filtered out before anything counts
            against your plan.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
