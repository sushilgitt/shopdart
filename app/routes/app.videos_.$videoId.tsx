import { useCallback } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import {
  type PickedProduct,
  repairEmptyVariantTags,
  setTagTiming,
  tagProducts,
  untagProduct,
} from "../lib/tagging.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // Tags written before variants were read from the Admin API carry an empty
  // variant list, which the player can only render as a link out to the product
  // page — no add to cart, and therefore no attribution. They are already
  // published, so they cannot fix themselves; heal them on the way in.
  await repairEmptyVariantTags(admin, shop.id, String(params.videoId));

  const video = await prisma.video.findFirst({
    where: { id: params.videoId, shopId: shop.id },
    include: { tags: { orderBy: { position: "asc" } } },
  });

  if (!video) {
    throw new Response("Video not found", { status: 404 });
  }

  return {
    video: {
      id: video.id,
      title: video.title ?? "Untitled",
      status: video.status as string,
      source: video.source as string,
      sourceUrl: video.sourceUrl,
      caption: video.caption,
      durationSec: video.durationSec,
      posterUrl: video.posterUrl,
      mp4Url: video.mp4Url,
      hlsUrl: video.hlsUrl,
    },
    tags: video.tags.map((tag) => ({
      id: tag.id,
      productGid: tag.productGid,
      title: tag.title ?? "Untitled product",
      imageUrl: tag.imageUrl,
      price: tag.priceAmount ? Number(tag.priceAmount) : null,
      startSec: tag.startSec,
      endSec: tag.endSec,
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const videoId = String(params.videoId);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "tag") {
    let products: PickedProduct[] = [];
    try {
      products = JSON.parse(String(form.get("products") ?? "[]"));
    } catch {
      return { ok: false as const, error: "Could not read the selection." };
    }
    const added = await tagProducts(admin, shop.id, videoId, products);
    return { ok: true as const, added };
  }

  if (intent === "untag") {
    await untagProduct(shop.id, videoId, String(form.get("tagId")));
    return { ok: true as const };
  }

  if (intent === "timing") {
    const parse = (value: FormDataEntryValue | null) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      const num = Number(text);
      return Number.isFinite(num) ? num : null;
    };
    await setTagTiming(
      shop.id,
      videoId,
      String(form.get("tagId")),
      parse(form.get("startSec")),
      parse(form.get("endSec")),
    );
    return { ok: true as const };
  }

  return { ok: false as const, error: "Unknown action" };
};

export default function VideoDetail() {
  const { video, tags } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const pickProducts = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "add",
      selectionIds: tags.map((tag) => ({ id: tag.productGid })),
    });

    // The picker resolves to undefined when the merchant cancels — an empty
    // array would mean "they deselected everything", which is different.
    if (!selection) return;

    fetcher.submit(
      { intent: "tag", products: JSON.stringify(selection) },
      { method: "POST" },
    );
  }, [shopify, tags, fetcher]);

  const ready = video.status === "READY";

  return (
    <s-page heading={video.title}>
      <s-button
        slot="primary-action"
        onClick={pickProducts}
        {...(!ready ? { disabled: true } : {})}
      >
        Tag products
      </s-button>
      <s-button slot="secondary-actions" href="/app/videos" variant="tertiary">
        Back to videos
      </s-button>

      {!ready && (
        <s-section heading="Still processing">
          <s-paragraph>
            You can tag products once Bunny Stream finishes encoding this video.
          </s-paragraph>
        </s-section>
      )}

      <s-section
        heading={
          tags.length > 0
            ? `${tags.length} product${tags.length === 1 ? "" : "s"} tagged`
            : "No products tagged yet"
        }
      >
        {tags.length === 0 ? (
          <s-paragraph>
            Tag the products that appear in this video. Shoppers can tap them in
            the player and buy without leaving the page.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {tags.map((tag) => (
              <s-box
                key={tag.id}
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
                    {tag.imageUrl && (
                      <img
                        src={tag.imageUrl}
                        alt=""
                        width={44}
                        height={44}
                        style={{
                          objectFit: "cover",
                          borderRadius: 4,
                          display: "block",
                        }}
                      />
                    )}
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">{tag.title}</s-text>
                      <s-text color="subdued">
                        {tag.price !== null ? formatMoney(tag.price) : "—"}
                        {tag.startSec !== null || tag.endSec !== null
                          ? ` · shown ${formatWindow(tag.startSec, tag.endSec)}`
                          : " · shown for the whole video"}
                      </s-text>
                    </s-stack>
                  </s-stack>

                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <Form method="post">
                      <input type="hidden" name="intent" value="timing" />
                      <input type="hidden" name="tagId" value={tag.id} />
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-text-field
                          name="startSec"
                          label="From (s)"
                          labelAccessibilityVisibility="exclusive"
                          placeholder="from"
                          value={tag.startSec?.toString() ?? ""}
                        />
                        <s-text-field
                          name="endSec"
                          label="To (s)"
                          labelAccessibilityVisibility="exclusive"
                          placeholder="to"
                          value={tag.endSec?.toString() ?? ""}
                        />
                        <s-button type="submit" variant="secondary">
                          Save
                        </s-button>
                      </s-stack>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="untag" />
                      <input type="hidden" name="tagId" value={tag.id} />
                      <s-button type="submit" variant="tertiary">
                        Remove
                      </s-button>
                    </Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Preview">
        {video.mp4Url ? (
          // No caption track exists: this previews the merchant's own uploaded
          // file, and Bunny does not generate captions. An empty <track> would
          // satisfy the rule while telling assistive tech a caption source
          // exists when none does.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={video.mp4Url}
            poster={video.posterUrl ?? undefined}
            controls
            playsInline
            preload="none"
            style={{ width: "100%", borderRadius: 8, display: "block" }}
          />
        ) : video.posterUrl ? (
          <img
            src={video.posterUrl}
            alt=""
            style={{ width: "100%", borderRadius: 8, display: "block" }}
          />
        ) : (
          <s-paragraph>
            <s-text color="subdued">No preview available yet.</s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Details">
        <s-paragraph>
          <s-text color="subdued">
            {video.source} · {video.status}
            {video.durationSec ? ` · ${formatDuration(video.durationSec)}` : ""}
          </s-text>
        </s-paragraph>
        {video.sourceUrl && (
          <s-paragraph>
            <s-link href={video.sourceUrl} target="_blank">
              View original post
            </s-link>
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

function formatMoney(amount: number): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatWindow(start: number | null, end: number | null): string {
  if (start !== null && end !== null) return `${start}s to ${end}s`;
  if (start !== null) return `from ${start}s`;
  if (end !== null) return `until ${end}s`;
  return "always";
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
