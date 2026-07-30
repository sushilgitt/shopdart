import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refreshCachedProduct } from "../lib/tagging.server";

interface ProductWebhookPayload {
  id: number;
  title?: string;
  handle?: string;
  image?: { src?: string } | null;
  images?: { src?: string }[];
  variants?: { price?: string }[];
}

/**
 * Keeps cached product details on ProductTag current.
 *
 * The storefront reads a static CDN payload and cannot call the Admin API, so
 * whatever is cached here is exactly what shoppers see. Without this, renaming
 * a product or changing its price leaves a stale — and in the price case,
 * wrong — value on the merchant's live storefront.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const product = payload as unknown as ProductWebhookPayload;

  if (!product?.id) return new Response();

  // Webhooks carry numeric REST ids; tags are keyed on the GraphQL gid.
  const productGid = `gid://shopify/Product/${product.id}`;

  const prices = (product.variants ?? [])
    .map((variant) => Number(variant.price))
    .filter((price) => Number.isFinite(price));

  const updated = await refreshCachedProduct(productGid, {
    title: product.title ?? null,
    handle: product.handle ?? null,
    imageUrl: product.image?.src ?? product.images?.[0]?.src ?? null,
    // Show the lowest variant price — the "from" figure a shopper expects on a
    // product card.
    priceAmount: prices.length > 0 ? Math.min(...prices) : null,
  });

  if (updated > 0) {
    console.log(`${topic} for ${shop}: refreshed ${updated} tag(s)`);
  }

  return new Response();
};

/** Shopify only POSTs here. Answering GET keeps stack traces out of the logs. */
export const loader = () => new Response("Method not allowed", { status: 405 });
