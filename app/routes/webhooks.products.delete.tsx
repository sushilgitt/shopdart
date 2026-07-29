import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { removeTagsForProduct } from "../lib/tagging.server";

/**
 * Drops tags for a deleted product.
 *
 * Left in place, the storefront would keep offering a product that 404s on
 * click — worse than not showing it at all.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const productId = (payload as unknown as { id?: number })?.id;

  if (!productId) return new Response();

  const removed = await removeTagsForProduct(
    `gid://shopify/Product/${productId}`,
  );
  if (removed > 0) {
    console.log(`${topic} for ${shop}: removed ${removed} tag(s)`);
  }

  return new Response();
};
