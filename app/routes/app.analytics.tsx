import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { currentPeriod } from "../lib/plans";
import { videoPerformance } from "../lib/attribution.server";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = RANGES.some((range) => range.days === requested) ? requested : 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  const [videos, counter] = await Promise.all([
    videoPerformance(shop.id, since),
    prisma.usageCounter.findUnique({
      where: { shopId_period: { shopId: shop.id, period: currentPeriod() } },
    }),
  ]);

  const totals = videos.reduce(
    (acc, video) => ({
      impressions: acc.impressions + video.impressions,
      views: acc.views + video.views,
      clicks: acc.clicks + video.clicks,
      addToCarts: acc.addToCarts + video.addToCarts,
      orders: acc.orders + video.orders,
      revenue: acc.revenue + video.revenue,
    }),
    {
      impressions: 0,
      views: 0,
      clicks: 0,
      addToCarts: 0,
      orders: 0,
      revenue: 0,
    },
  );

  return {
    days,
    ranges: RANGES,
    videos: videos.slice(0, 50),
    totals,
    monthViews: counter?.views ?? 0,
    currency: shop.currencyCode,
  };
};

export default function Analytics() {
  const { days, ranges, videos, totals, currency } =
    useLoaderData<typeof loader>();

  const rangeLabel =
    ranges.find((range) => range.days === days)?.label ?? `${days} days`;

  const rate = (numerator: number, denominator: number) =>
    denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "—";

  const money = (value: number) =>
    currency
      ? value.toLocaleString(undefined, { style: "currency", currency })
      : value.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

  return (
    <s-page heading="Analytics">
      <s-section heading={`Performance · ${rangeLabel}`}>
        <s-stack direction="inline" gap="small-200">
          {ranges.map((range) => (
            <s-button
              key={range.days}
              href={`/app/analytics?days=${range.days}`}
              variant={range.days === days ? "secondary" : "tertiary"}
            >
              {range.label}
            </s-button>
          ))}
        </s-stack>

        <s-stack direction="inline" gap="large">
          <Metric label="Views" value={totals.views.toLocaleString()} />
          <Metric
            label="Product taps"
            value={totals.clicks.toLocaleString()}
          />
          <Metric
            label="Added to cart"
            value={totals.addToCarts.toLocaleString()}
          />
          <Metric label="Orders" value={totals.orders.toLocaleString()} />
          <Metric label="Revenue" value={money(totals.revenue)} />
        </s-stack>

        {totals.views > 0 && (
          <s-paragraph>
            <s-text color="subdued">
              {rate(totals.clicks, totals.views)} of views tap a product ·{" "}
              {rate(totals.addToCarts, totals.clicks)} of those add to cart ·{" "}
              {rate(totals.orders, totals.addToCarts)} of those check out
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section
        heading={
          videos.length > 0 ? "Which videos earn their place" : "No data yet"
        }
      >
        {videos.length === 0 ? (
          <>
            <s-paragraph>
              Once a widget is live on your storefront, this shows what each
              video actually did — views, taps, add-to-carts, and the revenue it
              drove.
            </s-paragraph>
            <s-paragraph>
              <s-text color="subdued">
                Revenue is matched through cart attributes and the order
                webhook, so a sale is credited to the video that caused it
                rather than estimated.
              </s-text>
            </s-paragraph>
          </>
        ) : (
          <s-stack direction="block" gap="small-200">
            {videos.map((video) => (
              <s-box
                key={video.videoId}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  {video.posterUrl && (
                    <img
                      src={video.posterUrl}
                      alt=""
                      width={40}
                      height={54}
                      style={{
                        objectFit: "cover",
                        borderRadius: 4,
                        display: "block",
                      }}
                    />
                  )}
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">{video.title}</s-text>
                    <s-text color="subdued">
                      {video.views.toLocaleString()} views ·{" "}
                      {video.clicks.toLocaleString()} taps ·{" "}
                      {video.addToCarts.toLocaleString()} add-to-cart ·{" "}
                      {video.orders.toLocaleString()} orders ·{" "}
                      {money(video.revenue)} revenue
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="What counts as a view">
        <s-paragraph>
          <s-text color="subdued">
            One playback per shopper session, per video. Repeat impressions and
            known bots are filtered out before anything counts against your
            plan.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
