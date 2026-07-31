import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { createWidget, listWidgets } from "../lib/widget.server";
import {
  LAYOUTS,
  layoutName,
  type WidgetLayout,
} from "../lib/widget-config";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [widgets, readyVideos] = await Promise.all([
    listWidgets(shop.id),
    prisma.video.count({
      where: { shopId: shop.id, archivedAt: null, status: "READY" },
    }),
  ]);

  return {
    widgets: widgets.map((widget) => ({
      id: widget.id,
      name: widget.name,
      layout: widget.layout as WidgetLayout,
      status: widget.status as string,
      videoCount: widget._count.videos,
      placementCount: widget._count.placements,
    })),
    readyVideos,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  if (String(form.get("intent")) === "create") {
    const layout = String(form.get("layout")) as WidgetLayout;
    if (!LAYOUTS.some((entry) => entry.id === layout)) {
      return { ok: false as const, error: "Pick a layout." };
    }
    const widget = await createWidget(
      shop.id,
      String(form.get("name") ?? ""),
      layout,
    );
    return redirect(`/app/widgets/${widget.id}`);
  }

  return { ok: false as const, error: "Unknown action" };
};

export default function Widgets() {
  const { widgets, readyVideos } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Widgets">
      {widgets.length > 0 && (
        <s-section
          heading={`${widgets.length} widget${widgets.length === 1 ? "" : "s"}`}
        >
          <s-stack direction="block" gap="small-200">
            {widgets.map((widget) => (
              <s-box
                key={widget.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">{widget.name}</s-text>
                    <s-text color="subdued">
                      {layoutName(widget.layout)} ·{" "}
                      {widget.status === "PUBLISHED" ? "Live" : "Draft"} ·{" "}
                      {widget.videoCount} video
                      {widget.videoCount === 1 ? "" : "s"} ·{" "}
                      {widget.placementCount} placement
                      {widget.placementCount === 1 ? "" : "s"}
                    </s-text>
                  </s-stack>
                  <s-button
                    href={`/app/widgets/${widget.id}`}
                    variant="secondary"
                  >
                    Edit
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section
        heading={
          widgets.length > 0
            ? "Create another widget"
            : "Create your first widget"
        }
      >
        {readyVideos === 0 && (
          <s-paragraph>
            <s-text color="subdued">
              You have no videos ready yet. You can still set a widget up and
              add videos once they finish encoding.
            </s-text>
          </s-paragraph>
        )}
        <s-stack direction="block" gap="small-200">
          {LAYOUTS.map((layout) => (
            <s-box
              key={layout.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <Form method="post">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="layout" value={layout.id} />
                <input type="hidden" name="name" value={layout.name} />
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">{layout.name}</s-text>
                    <s-text color="subdued">{layout.detail}</s-text>
                  </s-stack>
                  <s-button type="submit" variant="secondary">
                    Create
                  </s-button>
                </s-stack>
              </Form>
            </s-box>
          ))}
        </s-stack>
      </s-section>

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
