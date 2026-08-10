import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureShop, updateShopProfile } from "../lib/shop.server";
import { syncPlanFromShopify } from "../lib/billing.server";
import { ensureWebPixel } from "../lib/pixel.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Shopify sends no "app installed" webhook, so this is where a shop first
  // gets provisioned.
  const shop = await ensureShop(session.shop);

  // Backfill store details once. Currency in particular matters: without it
  // every price in the app and on the storefront renders as a bare number,
  // which reads as a bug to anyone outside the merchant's country.
  if (!shop.currencyCode) {
    try {
      const response = await admin.graphql(
        `#graphql
          query shopdartShopProfile {
            shop {
              name
              contactEmail
              ianaTimezone
              currencyCode
              billingAddress { countryCodeV2 }
            }
          }`,
      );
      const body = await response.json();
      const profile = body?.data?.shop;
      if (profile) {
        await updateShopProfile(session.shop, {
          name: profile.name ?? null,
          email: profile.contactEmail ?? null,
          currencyCode: profile.currencyCode ?? null,
          countryCode: profile.billingAddress?.countryCodeV2 ?? null,
          timezone: profile.ianaTimezone ?? null,
        });
      }
    } catch (error) {
      // Never block the admin from loading over a cosmetic backfill.
      console.error("Shop profile backfill failed", error);
    }
  }

  // Reconcile the stored plan with the real subscription on every load.
  //
  // Shopify appends `plan_handle` to the redirect after a plan is chosen, but
  // that is a query parameter and anyone can type one — so it is ignored
  // entirely and the subscription is read from the Admin API instead. Doing it
  // on every load, rather than only after a selection, also means a
  // cancellation or failed payment takes effect without the merchant passing
  // back through the pricing page.
  await syncPlanFromShopify(admin, session.shop);

  // Shopify only delivers customer events once a WebPixel record exists on the
  // shop, and only the app can create one. Without it the checkout_completed
  // subscription never fires and orders are never attributed. Cached on the
  // Shop row, so this is a no-op after the first load.
  await ensureWebPixel(admin, session.shop);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/videos">Videos</s-link>
        <s-link href="/app/instagram">Instagram</s-link>
        <s-link href="/app/youtube">YouTube</s-link>
        <s-link href="/app/widgets">Widgets</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
