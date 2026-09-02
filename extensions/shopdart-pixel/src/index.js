// Resolved from the repo root's devDependencies — this extension deliberately
// has no package.json of its own. A workspace here would add an entry to
// package-lock.json that `npm ci` expects to find on disk, and the Dockerfile
// runs `npm ci` before it copies the source, so the production build would
// fail on a file that isn't there yet.
import { register } from "@shopify/web-pixels-extension";

/**
 * DPS purchase attribution.
 *
 * Why a pixel at all, when the player already reports everything else:
 * checkout is not the storefront. The theme extension's script is not loaded
 * there, so the moment a shopper leaves for checkout the player stops being
 * able to observe anything — including the one event a merchant cares about
 * most. Orders and revenue therefore read zero no matter how well the rest of
 * the pipeline worked.
 *
 * The alternative is the orders/create webhook, which needs `read_orders`.
 * That is protected customer data and cannot be requested until the app is
 * approved, so it cannot be the thing that makes the app work during review.
 * This pixel needs no protected scope: Shopify filters PII fields out of pixel
 * payloads for apps without them, and nothing read here is PII — a checkout
 * attribute we wrote ourselves, an order id, and a total.
 *
 * Scope is deliberately narrow. This subscribes to checkout_completed and
 * nothing else. Add-to-cart is still reported by the player, because it can
 * see which video the tap came from and the pixel cannot; having both report
 * it would double-count every in-player add, which is worse than the gap it
 * would close.
 */

// Same deployed origin as the theme extension. One line to change if the
// domain moves.
const ORIGIN = "https://shopdart.91.239.208.85.sslip.io";

const ATTR_VIDEO = "_shopdart_video";
const ATTR_WIDGET = "_shopdart_widget";
const ATTR_SESSION = "_shopdart_session";

/**
 * Reads one of our own cart attributes off the checkout.
 *
 * These are the attributes the player writes with /cart/update.js when a
 * shopper taps a product. Cart attributes survive into the checkout, which is
 * what makes attribution deterministic rather than modelled.
 */
function attribute(attributes, key) {
  const found = (attributes || []).find((entry) => entry && entry.key === key);
  const value = found && found.value ? String(found.value).trim() : "";
  return value || null;
}

/**
 * A stable identity for this order.
 *
 * Prefers the real order id so a purchase recorded here and one recorded by the
 * orders/create webhook collapse onto the same row — the server dedupes on
 * (orderGid, videoId, type), and the two sources must agree on the key or the
 * merchant's revenue doubles the day that webhook is switched on.
 *
 * The checkout token is the fallback, namespaced so it can never be mistaken
 * for an order id.
 */
function orderKey(checkout) {
  const raw = checkout && checkout.order ? checkout.order.id : null;
  if (raw) {
    const numeric = String(raw).split("/").pop();
    if (numeric) return `gid://shopify/Order/${numeric}`;
  }
  if (checkout && checkout.token) {
    return `shopdart://checkout/${checkout.token}`;
  }
  return null;
}

register(({ analytics, settings, init }) => {
  const shop =
    (settings && settings.shop) ||
    (init && init.data && init.data.shop && init.data.shop.myshopifyDomain) ||
    null;

  if (!shop) return;

  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event && event.data ? event.data.checkout : null;
    if (!checkout) return;

    const videoId = attribute(checkout.attributes, ATTR_VIDEO);
    // No DPS attribute means this sale had nothing to do with a video.
    // Staying silent is the correct answer, not a zero-value purchase row.
    if (!videoId) return;

    const orderGid = orderKey(checkout);
    if (!orderGid) return;

    const total =
      checkout.totalPrice && checkout.totalPrice.amount !== undefined
        ? Number(checkout.totalPrice.amount)
        : 0;

    const body = JSON.stringify({
      shop,
      events: [
        {
          type: "PURCHASE",
          videoId,
          widgetId: attribute(checkout.attributes, ATTR_WIDGET),
          session: attribute(checkout.attributes, ATTR_SESSION),
          orderGid,
          value: Number.isFinite(total) ? total : 0,
          currency: checkout.currencyCode || null,
        },
      ],
    });

    // text/plain keeps this a CORS-simple request. application/json would force
    // a preflight, and the endpoint cannot answer one — see api.events.tsx.
    fetch(`${ORIGIN}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
      keepalive: true,
    }).catch(() => {
      // A failed analytics call must never surface on a shopper's thank-you
      // page. The order itself is unaffected.
    });
  });
});
