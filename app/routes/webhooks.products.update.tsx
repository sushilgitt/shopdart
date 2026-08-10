import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchProductDetails,
  hasTagsForProduct,
  refreshCachedProduct,
} from "../lib/tagging.server";

interface ProductWebhookPayload {
  id?: number;
}

/**
 * Keeps cached product details on ProductTag current.
 *
 * The storefront reads a static payload and cannot call the Admin API, so
 * whatever is cached here is exactly what shoppers see. Without this, renaming
 * a product or changing its price leaves a stale — and in the price case,
 * wrong — value on the merchant's live storefront.
 *
 * The webhook body is used only to learn *which* product changed. Everything
 * written comes from the Admin API instead, because the payload cannot be
 * trusted on the one field that matters most: availability.
 *
 * The previous version inferred it from raw REST fields — `inventory_management`,
 * `inventory_policy`, `inventory_quantity` — and returned "buyable" whenever
 * `inventory_management` was absent. Recent API versions omit inventory fields
 * from webhook payloads for apps without `read_inventory`, so that guard could
 * silently mark every variant of every product buyable forever. Shoppers would
 * be offered sold-out options and get a dead button.
 *
 * `availableForSale` from the Admin API is the authoritative answer, already
 * accounts for tracking and oversell policy, and needs no scope beyond
 * `read_products`. It is also the same call `tagProducts` makes, so the cache
 * cannot drift depending on which path last wrote it.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  const product = payload as unknown as ProductWebhookPayload;

  if (!product?.id) return new Response();

  // Webhooks carry numeric REST ids; tags are keyed on the GraphQL gid.
  const productGid = `gid://shopify/Product/${product.id}`;

  // Most products in a shop are never tagged, and a bulk edit fires one webhook
  // each. Checking first keeps a catalogue-wide price change from turning into
  // an Admin API call per product.
  if (!(await hasTagsForProduct(productGid))) return new Response();

  // No session means the shop has uninstalled; its tags are already dormant.
  if (!admin) return new Response();

  let updated = 0;
  try {
    const details = await fetchProductDetails(admin, [productGid]);
    const detail = details.get(productGid);

    // Absent means the product is no longer readable. products/delete handles
    // real deletions; treating a transient read failure as one would drop tags
    // a merchant still wants.
    if (!detail) return new Response();

    updated = await refreshCachedProduct(productGid, {
      title: detail.title,
      handle: detail.handle,
      imageUrl: detail.imageUrl,
      priceAmount: detail.priceAmount,
      variants: detail.variants,
    });
  } catch (error) {
    // 500 so Shopify retries — a missed refresh leaves a wrong price live.
    console.error(`${topic} refresh failed for ${shop}`, error);
    return new Response("Refresh failed", { status: 500 });
  }

  if (updated > 0) {
    console.log(`${topic} for ${shop}: refreshed ${updated} tag(s)`);
  }

  return new Response();
};

/** Shopify only POSTs here. Answering GET keeps stack traces out of the logs. */
export const loader = () => new Response("Method not allowed", { status: 405 });
