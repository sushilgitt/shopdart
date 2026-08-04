import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  type CustomersDataRequestPayload,
  type CustomersRedactPayload,
} from "../lib/compliance.server";

/**
 * Shopify's three mandatory compliance webhooks: /webhooks/compliance
 *
 * All three arrive here rather than at separate routes because they share the
 * same verification and differ only in what they delete. `authenticate.webhook`
 * validates the HMAC — Shopify sends deliberately unsigned probes during
 * review, and answering one of those with a 200 is a review failure.
 *
 * Anything other than a 2xx is treated as a failure to comply, so unknown
 * topics are acknowledged rather than rejected.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        const result = await handleCustomersDataRequest(
          shop,
          payload as unknown as CustomersDataRequestPayload,
        );
        console.log(
          `${topic} for ${shop}: ${result.orderEvents} attribution row(s) relate to the requested orders`,
        );
        break;
      }

      case "CUSTOMERS_REDACT": {
        const result = await handleCustomersRedact(
          shop,
          payload as unknown as CustomersRedactPayload,
        );
        console.log(`${topic} for ${shop}: deleted ${result.deleted} row(s)`);
        break;
      }

      case "SHOP_REDACT": {
        const result = await handleShopRedact(shop);
        console.log(
          `${topic} for ${shop}: shop deleted=${result.shopDeleted}, ${result.videosDeleted} video(s) removed from Bunny`,
        );
        break;
      }

      default:
        console.log(`Unhandled compliance topic ${topic} for ${shop}`);
    }
  } catch (error) {
    // 500 so Shopify retries. Silently dropping a redaction request is the
    // failure this endpoint exists to prevent.
    console.error(`Compliance webhook ${topic} failed for ${shop}`, error);
    return new Response("Compliance handler error", { status: 500 });
  }

  return new Response();
};

/** Shopify only POSTs here. Answering GET keeps stack traces out of the logs. */
export const loader = () => new Response("Method not allowed", { status: 405 });
