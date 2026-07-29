import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { encrypt, verifyState } from "../lib/crypto.server";
import {
  exchangeCode,
  exchangeForLongLivedToken,
  fetchProfile,
} from "../lib/instagram.server";

interface StatePayload {
  shop: string;
  ts: number;
}

/**
 * Instagram OAuth callback.
 *
 * Public by necessity: Instagram redirects the browser here directly, with no
 * Shopify session token, so `authenticate.admin` cannot run. The shop domain
 * travels in the signed `state` parameter instead — without that signature,
 * anyone could bind their own Instagram account to another merchant's store by
 * editing the query string.
 *
 * Opened in a new tab from the embedded admin, so this renders a plain page
 * rather than redirecting back into the Shopify frame.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const errorReason = url.searchParams.get("error_reason");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    return {
      ok: false as const,
      message:
        errorReason === "user_denied"
          ? "You cancelled the connection. Nothing was changed."
          : `Instagram returned an error: ${error}`,
    };
  }

  if (!code || !state) {
    return { ok: false as const, message: "Missing authorization code." };
  }

  const payload = verifyState<StatePayload>(state);
  if (!payload?.shop) {
    return {
      ok: false as const,
      message:
        "This link is invalid or has expired. Start the connection again from Shopdart.",
    };
  }

  const shop = await prisma.shop.findUnique({ where: { domain: payload.shop } });
  if (!shop) {
    return { ok: false as const, message: "That store is no longer installed." };
  }

  try {
    const shortLived = await exchangeCode(code);
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    const profile = await fetchProfile(longLived.accessToken);

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        igUserId: profile.id,
        igUsername: profile.username,
        // Encrypted at rest — this token can read the merchant's media for 60
        // days and must never sit in the database in plaintext.
        igAccessToken: encrypt(longLived.accessToken),
        igTokenExpiresAt: longLived.expiresAt,
        igLastSyncedAt: null,
      },
    });

    return { ok: true as const, username: profile.username };
  } catch (caught) {
    console.error("Instagram connection failed", caught);
    return {
      ok: false as const,
      message:
        "Could not complete the connection. Please try again from Shopdart.",
    };
  }
};

export default function InstagramCallback() {
  const result = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        maxWidth: 460,
        margin: "0 auto",
        padding: "72px 24px",
        textAlign: "center",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>
        {result.ok ? "Instagram connected" : "Couldn't connect Instagram"}
      </h1>
      <p style={{ margin: "0 0 20px", color: "#5c6b70" }}>
        {result.ok
          ? `Connected as @${result.username}. You can close this tab and return to Shopdart to import your reels.`
          : result.message}
      </p>
      <button
        type="button"
        onClick={() => window.close()}
        style={{
          font: "inherit",
          padding: "9px 18px",
          borderRadius: 6,
          border: "1px solid #c9d2d4",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        Close this tab
      </button>
    </main>
  );
}
