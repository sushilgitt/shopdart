import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureShop, updateShopProfile } from "../lib/shop.server";
import { applyPlanHandle } from "../lib/billing.server";

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

  // Shopify App Pricing appends `plan_handle` to whatever redirect URL is
  // configured after a merchant picks a plan, and they can land on any page
  // in the app — so it is read here, at the root, rather than on a dedicated
  // billing callback route.
  const planHandle = new URL(request.url).searchParams.get("plan_handle");
  if (planHandle) {
    await applyPlanHandle(session.shop, planHandle);
  }

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
