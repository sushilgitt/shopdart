import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { attributeOrder } from "../lib/attribution.server";

/**
 * Credits an order to the video that drove it.
 *
 * Requires the read_orders scope, which is protected customer data — request
 * approval in the Partner dashboard before submitting for review.
 *
 * Only the Shopdart cart attributes are read. Nothing about the customer is
 * stored: the attribution row holds an order id and a total, not a person.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  try {
    const attributed = await attributeOrder(shop, payload as never);
    if (attributed) {
      console.log(`${topic} for ${shop}: attributed to a Shopdart video`);
    }
  } catch (error) {
    console.error(`${topic} attribution failed for ${shop}`, error);
    // 500 so Shopify retries — a dropped order is revenue the merchant never
    // sees credited.
    return new Response("Attribution error", { status: 500 });
  }

  return new Response();
};

/** Shopify only POSTs here. Answering GET keeps stack traces out of the logs. */
export const loader = () => new Response("Method not allowed", { status: 405 });
