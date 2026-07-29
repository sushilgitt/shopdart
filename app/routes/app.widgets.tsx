import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";

const LAYOUTS = [
  { id: "GALLERY", name: "Video gallery", detail: "A grid of videos on any page." },
  { id: "CAROUSEL", name: "Carousel", detail: "A horizontal row shoppers swipe through." },
  { id: "STORIES", name: "Stories", detail: "Tappable circles in a bar, like Instagram." },
  { id: "FLOATING", name: "Floating video", detail: "A small player pinned to a corner." },
  { id: "PRODUCT_PAGE", name: "Product page", detail: "Videos featuring the product being viewed." },
  { id: "POPUP", name: "Popup", detail: "A full-screen player triggered on click." },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const widgets = await prisma.widget.findMany({
    where: { shopId: shop.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { videos: true, placements: true } },
    },
  });

  return {
    widgets: widgets.map((widget) => ({
      id: widget.id,
      name: widget.name,
      layout: widget.layout,
      status: widget.status,
      videoCount: widget._count.videos,
      placementCount: widget._count.placements,
    })),
  };
};

export default function Widgets() {
  const { widgets } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Widgets">
      <s-button slot="primary-action" disabled>
        Create widget
      </s-button>

      {widgets.length === 0 ? (
        <s-section heading="No widgets yet">
          <s-paragraph>
            A widget is a set of videos plus a layout and a place to show it.
            Six layouts ship with Shopdart:
          </s-paragraph>
          <s-stack direction="block" gap="base">
            {LAYOUTS.map((layout) => (
              <s-box
                key={layout.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{layout.name}</s-text>
                  <s-text color="subdued">{layout.detail}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      ) : (
        <s-section heading={`${widgets.length} widget${widgets.length === 1 ? "" : "s"}`}>
          <s-stack direction="block" gap="base">
            {widgets.map((widget) => (
              <s-box
                key={widget.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{widget.name}</s-text>
                  <s-text color="subdued">
                    {widget.layout} · {widget.status} · {widget.videoCount} video
                    {widget.videoCount === 1 ? "" : "s"} ·{" "}
                    {widget.placementCount} placement
                    {widget.placementCount === 1 ? "" : "s"}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="How publishing works">
        <s-paragraph>
          <s-text color="subdued">
            Widget settings are served to your storefront as a cached file on a
            global CDN, not fetched from our server. Your videos keep playing
            even if Shopdart is down, and edits go live immediately.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
