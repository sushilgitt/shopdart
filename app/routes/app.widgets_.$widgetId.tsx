import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useSubmit,
} from "react-router";
import { PlacementTarget, WidgetStatus } from "@prisma/client";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import {
  deleteWidget,
  getWidget,
  setPlacements,
  setWidgetStatus,
  setWidgetVideos,
  updateWidgetConfig,
} from "../lib/widget.server";
import {
  ASPECT_RATIOS,
  PLACEMENT_TARGETS,
  layoutName,
  parseConfig,
} from "../lib/widget-config";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const widget = await getWidget(shop.id, String(params.widgetId));
  if (!widget) throw new Response("Widget not found", { status: 404 });

  const library = await prisma.video.findMany({
    where: { shopId: shop.id, archivedAt: null, status: "READY" },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { tags: true } } },
  });

  const positions = new Map(
    widget.videos.map((entry) => [entry.videoId, entry.position]),
  );
  const selected = new Set(widget.videos.map((entry) => entry.videoId));

  return {
    widget: {
      id: widget.id,
      name: widget.name,
      layout: widget.layout,
      layoutLabel: layoutName(widget.layout),
      status: widget.status as string,
      configVersion: widget.configVersion,
    },
    config: parseConfig(widget.config, widget.layout),
    placements: widget.placements.map((placement) => placement.target as string),
    library: library
      .map((video) => ({
        id: video.id,
        title: video.title ?? "Untitled",
        posterUrl: video.posterUrl,
        tagCount: video._count.tags,
        selected: selected.has(video.id),
        position: positions.get(video.id) ?? null,
      }))
      // Show chosen videos first, in the order they'll actually play.
      .sort((a, b) => {
        if (a.selected !== b.selected) return a.selected ? -1 : 1;
        if (a.selected && b.selected) {
          return (a.position ?? 0) - (b.position ?? 0);
        }
        return 0;
      }),
    untaggedSelected: widget.videos.filter(
      (entry) => entry.video._count.tags === 0,
    ).length,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const widgetId = String(params.widgetId);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "config") {
    await updateWidgetConfig(shop.id, widgetId, {
      name: String(form.get("name") ?? ""),
      heading: String(form.get("heading") ?? ""),
      accentColor: String(form.get("accentColor") ?? ""),
      accentTextColor: String(form.get("accentTextColor") ?? ""),
      ctaLabel: String(form.get("ctaLabel") ?? ""),
      aspectRatio: String(form.get("aspectRatio") ?? "") as never,
      cornerRadius: Number(form.get("cornerRadius")),
      itemsPerRow: Number(form.get("itemsPerRow")),
      autoplay: form.get("autoplay") === "on",
      muted: form.get("muted") === "on",
      loop: form.get("loop") === "on",
      showCaption: form.get("showCaption") === "on",
      showProductCard: form.get("showProductCard") === "on",
    });
    return { ok: true as const, saved: "settings" };
  }

  if (intent === "videos") {
    // Checkboxes arrive in DOM order, which is library order. The merchant's
    // intended order comes from the numeric inputs beside them, so sort by
    // that before saving — otherwise videos are permanently stuck newest-first.
    const chosen = form.getAll("videoId").map(String);
    const ordered = chosen
      .map((id) => ({
        id,
        position: Number(form.get(`position:${id}`) ?? Number.MAX_SAFE_INTEGER),
      }))
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.id);

    await setWidgetVideos(shop.id, widgetId, ordered);
    return { ok: true as const, saved: "videos" };
  }

  if (intent === "placements") {
    const targets = form
      .getAll("target")
      .map(String)
      .filter((value): value is PlacementTarget =>
        Object.values(PlacementTarget).includes(value as PlacementTarget),
      );
    await setPlacements(
      shop.id,
      widgetId,
      targets.map((target) => ({ target })),
    );
    return { ok: true as const, saved: "placements" };
  }

  if (intent === "publish" || intent === "unpublish") {
    await setWidgetStatus(
      shop.id,
      widgetId,
      intent === "publish" ? WidgetStatus.PUBLISHED : WidgetStatus.DRAFT,
    );
    return { ok: true as const, saved: intent };
  }

  if (intent === "delete") {
    await deleteWidget(shop.id, widgetId);
    return redirect("/app/widgets");
  }

  return { ok: false as const, error: "Unknown action" };
};

/**
 * What each save actually did, in the merchant's words.
 *
 * This page has three independent save buttons plus publish and unpublish, and
 * previously none of them acknowledged anything — the action's return value was
 * simply discarded. A merchant could click Save, have nothing happen, and see a
 * page identical to a successful save. Naming the specific thing that saved
 * also tells them *which* of the three buttons they just pressed.
 */
const SAVED_MESSAGE: Record<string, string> = {
  settings: "Settings saved",
  videos: "Video selection saved",
  placements: "Placements saved",
  publish: "Widget published",
  unpublish: "Widget unpublished",
};

export default function WidgetEditor() {
  const { widget, config, placements, library, untaggedSelected } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const shopify = useAppBridge();

  useEffect(() => {
    if (!actionData) return;
    if (actionData.ok) {
      shopify.toast.show(SAVED_MESSAGE[actionData.saved] ?? "Saved");
    } else {
      shopify.toast.show(actionData.error ?? "Could not save", {
        isError: true,
      });
    }
  }, [actionData, shopify]);

  const live = widget.status === "PUBLISHED";
  const selectedCount = library.filter((video) => video.selected).length;

  return (
    <s-page heading={widget.name}>
      {/*
        Must be a bare s-button. s-page only projects the button itself into
        the primary-action slot, so wrapping it in a form element makes the
        control disappear from the page header entirely rather than render
        unstyled — which is why publishing was impossible from the UI.
      */}
      <s-button
        slot="primary-action"
        onClick={() =>
          submit({ intent: live ? "unpublish" : "publish" }, { method: "post" })
        }
        {...(!live && selectedCount === 0 ? { disabled: true } : {})}
      >
        {live ? "Unpublish" : "Publish"}
      </s-button>
      <s-button slot="secondary-actions" href="/app/widgets" variant="tertiary">
        Back to widgets
      </s-button>

      <s-section heading="Settings">
        <Form method="post">
          <input type="hidden" name="intent" value="config" />
          <s-stack direction="block" gap="base">
            <s-text-field name="name" label="Widget name" value={widget.name} />
            <s-text-field
              name="heading"
              label="Heading shown on the storefront"
              value={config.heading}
              placeholder="Leave blank for no heading"
            />
            <s-text-field
              name="ctaLabel"
              label="Button text"
              value={config.ctaLabel}
            />
            <s-select
              name="aspectRatio"
              label="Video shape"
              value={config.aspectRatio}
            >
              {ASPECT_RATIOS.map((ratio) => (
                <s-option key={ratio} value={ratio}>
                  {ratio}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              name="itemsPerRow"
              label="Videos per row"
              min={1}
              max={8}
              value={String(config.itemsPerRow)}
            />
            <s-number-field
              name="cornerRadius"
              label="Corner radius (px)"
              min={0}
              max={999}
              value={String(config.cornerRadius)}
            />
            <s-color-field
              name="accentColor"
              label="Accent colour"
              value={config.accentColor}
            />
            <s-color-field
              name="accentTextColor"
              label="Accent text colour"
              value={config.accentTextColor}
            />
            <s-checkbox name="autoplay" label="Autoplay" checked={config.autoplay} />
            <s-checkbox
              name="muted"
              label="Start muted (required for autoplay to work)"
              checked={config.muted}
            />
            <s-checkbox name="loop" label="Loop" checked={config.loop} />
            <s-checkbox
              name="showProductCard"
              label="Show tagged products in the player"
              checked={config.showProductCard}
            />
            <s-checkbox
              name="showCaption"
              label="Show captions"
              checked={config.showCaption}
            />
            <s-button type="submit">Save settings</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section
        heading={`Videos${selectedCount > 0 ? ` (${selectedCount} selected)` : ""}`}
      >
        {library.length === 0 ? (
          <s-paragraph>
            No videos are ready yet. Upload one or import from Instagram, then
            come back to add it here.
          </s-paragraph>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="videos" />
            <s-paragraph>
              <s-text color="subdued">
                Tick the videos to include. The order number controls the order
                they play in — lowest first.
              </s-text>
            </s-paragraph>
            <s-stack direction="block" gap="small-200">
              {library.map((video, index) => (
                <s-box
                  key={video.id}
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
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-checkbox
                        name="videoId"
                        value={video.id}
                        label={video.title}
                        checked={video.selected}
                      />
                      <s-text color="subdued">
                        {video.tagCount > 0
                          ? `${video.tagCount} product${video.tagCount === 1 ? "" : "s"}`
                          : "No products tagged"}
                      </s-text>
                    </s-stack>
                    <s-number-field
                      name={`position:${video.id}`}
                      label="Order"
                      labelAccessibilityVisibility="exclusive"
                      min={1}
                      max={999}
                      value={String(
                        video.position !== null ? video.position + 1 : index + 1,
                      )}
                    />
                  </s-stack>
                </s-box>
              ))}
              <s-button type="submit">Save video selection</s-button>
            </s-stack>
          </Form>
        )}
      </s-section>

      <s-section heading="Where it appears">
        <Form method="post">
          <input type="hidden" name="intent" value="placements" />
          <s-stack direction="block" gap="small-200">
            {PLACEMENT_TARGETS.map((target) => (
              <s-box
                key={target.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-checkbox
                    name="target"
                    value={target.id}
                    label={target.name}
                    checked={placements.includes(target.id)}
                  />
                  <s-text color="subdued">{target.detail}</s-text>
                </s-stack>
              </s-box>
            ))}
            <s-button type="submit">Save placements</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section slot="aside" heading="Status">
        <s-paragraph>
          <s-text type="strong">{live ? "Live" : "Draft"}</s-text>
          <s-text color="subdued"> · {widget.layoutLabel}</s-text>
        </s-paragraph>
        {selectedCount === 0 && (
          <s-paragraph>
            <s-text color="subdued">
              Add at least one video before publishing.
            </s-text>
          </s-paragraph>
        )}
        {untaggedSelected > 0 && (
          <s-paragraph>
            <s-text color="subdued">
              {untaggedSelected} selected video
              {untaggedSelected === 1 ? " has" : "s have"} no tagged products, so
              shoppers won&rsquo;t be able to buy from{" "}
              {untaggedSelected === 1 ? "it" : "them"}.
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Danger zone">
        <Form method="post">
          <input type="hidden" name="intent" value="delete" />
          <s-button type="submit" variant="tertiary">
            Delete widget
          </s-button>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
