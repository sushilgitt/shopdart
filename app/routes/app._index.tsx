import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { currentPeriod, planFor } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const period = currentPeriod();

  const [videoCount, readyCount, widgetCount, publishedCount, usage] =
    await Promise.all([
      prisma.video.count({
        // Matches countActiveVideos: staged posts hold no plan slot and are
        // not part of the library until a file arrives.
        where: { shopId: shop.id, archivedAt: null, status: { not: "PENDING" } },
      }),
      prisma.video.count({
        where: { shopId: shop.id, archivedAt: null, status: "READY" },
      }),
      prisma.widget.count({ where: { shopId: shop.id } }),
      prisma.widget.count({
        where: { shopId: shop.id, status: "PUBLISHED" },
      }),
      prisma.usageCounter.findUnique({
        where: { shopId_period: { shopId: shop.id, period } },
      }),
    ]);

  const plan = planFor(shop.plan);

  return {
    shopDomain: shop.domain,
    instagramConnected: Boolean(shop.igUserId),
    plan: { name: plan.name, views: plan.views, videos: plan.videos },
    videoCount,
    readyCount,
    widgetCount,
    publishedCount,
    usage: {
      views: usage?.views ?? 0,
      clicks: usage?.clicks ?? 0,
      addToCarts: usage?.addToCarts ?? 0,
      orders: usage?.orders ?? 0,
      revenue: usage?.revenue ? Number(usage.revenue) : 0,
    },
  };
};

export default function Dashboard() {
  const {
    instagramConnected,
    plan,
    videoCount,
    readyCount,
    widgetCount,
    publishedCount,
    usage,
  } = useLoaderData<typeof loader>();

  const steps = [
    {
      done: instagramConnected || videoCount > 0,
      label: "Add your first video",
      detail: "Connect Instagram or upload an MP4 from your computer.",
      href: "/app/videos",
      action: "Add videos",
    },
    {
      done: widgetCount > 0,
      label: "Create a widget",
      detail: "Pick a layout, choose videos, and tag the products they feature.",
      href: "/app/widgets",
      action: "Create widget",
    },
    {
      done: publishedCount > 0,
      label: "Publish it to your storefront",
      detail: "Add the DPS block to your theme where you want it to show.",
      href: "/app/widgets",
      action: "Publish",
    },
  ];

  const remaining = steps.filter((step) => !step.done).length;
  const viewsPct = plan.views > 0 ? Math.min(100, Math.round((usage.views / plan.views) * 100)) : 0;

  return (
    <s-page heading="DPS">
      <s-button slot="primary-action" href="/app/videos">
        Add videos
      </s-button>

      {remaining > 0 && (
        <s-section heading="Finish setting up">
          <s-paragraph>
            {remaining === steps.length
              ? "Three steps to your first shoppable video."
              : `${remaining} step${remaining === 1 ? "" : "s"} left.`}
          </s-paragraph>
          <s-stack direction="block" gap="base">
            {steps.map((step) => (
              <s-box
                key={step.label}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background={step.done ? "subdued" : undefined}
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">
                      {step.done ? "✓ " : ""}
                      {step.label}
                    </s-text>
                    <s-text color="subdued">{step.detail}</s-text>
                  </s-stack>
                  {!step.done && (
                    <s-button href={step.href} variant="secondary">
                      {step.action}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="This month">
        <s-stack direction="inline" gap="large">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Video views</s-text>
            <s-heading>{usage.views.toLocaleString()}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Product clicks</s-text>
            <s-heading>{usage.clicks.toLocaleString()}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Added to cart</s-text>
            <s-heading>{usage.addToCarts.toLocaleString()}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Orders</s-text>
            <s-heading>{usage.orders.toLocaleString()}</s-heading>
          </s-stack>
        </s-stack>
        <s-paragraph>
          <s-text color="subdued">
            Updated as shoppers watch and buy. Views and product taps appear
            within about a minute; orders are credited when checkout completes.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Library">
        <s-paragraph>
          <s-text type="strong">{videoCount}</s-text>
          <s-text color="subdued">
            {" "}
            of {plan.videos.toLocaleString()} videos used
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            {readyCount} ready to publish · {widgetCount} widget
            {widgetCount === 1 ? "" : "s"} ({publishedCount} live)
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading={`${plan.name} plan`}>
        <s-paragraph>
          <s-text type="strong">{usage.views.toLocaleString()}</s-text>
          <s-text color="subdued">
            {" "}
            of {plan.views.toLocaleString()} monthly views ({viewsPct}%)
          </s-text>
        </s-paragraph>
        <s-button href="/app/settings" variant="secondary">
          Manage plan
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
