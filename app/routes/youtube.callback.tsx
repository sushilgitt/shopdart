import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import prisma from "../db.server";
import { signState, verifyState } from "../lib/crypto.server";
import {
  exchangeCode,
  fetchOwnChannels,
  revokeToken,
  type OwnedChannel,
} from "../lib/youtube-oauth.server";
import { attachVerifiedChannel } from "../lib/youtube-sync.server";

/**
 * Google OAuth callback: /youtube/callback
 *
 * Public by necessity — Google redirects the browser here with no Shopify
 * session token, so `authenticate.admin` cannot run. The shop travels in the
 * signed `state` parameter, exactly as it does for Instagram; without that
 * signature anyone could bind a channel to another merchant's store.
 *
 * Opened in a new tab from the embedded admin, so it renders a plain page.
 */

interface StatePayload {
  shop: string;
  ts: number;
}

/** Channel list handed to the picker, signed so it cannot be tampered with. */
interface ChoicePayload {
  shop: string;
  channels: OwnedChannel[];
  ts: number;
}

type Result =
  | { ok: true; channelTitle: string }
  | { ok: false; message: string }
  | { ok: "choose"; choice: string; channels: OwnedChannel[] };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<Result> => {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    return {
      ok: false,
      message:
        error === "access_denied"
          ? "You cancelled the connection. Nothing was changed."
          : `Google returned an error: ${error}`,
    };
  }

  if (!code || !state) {
    return { ok: false, message: "Missing authorization code." };
  }

  const payload = verifyState<StatePayload>(state);
  if (!payload?.shop) {
    return {
      ok: false,
      message:
        "This link is invalid or has expired. Start the connection again from Shopdart.",
    };
  }

  const shop = await prisma.shop.findUnique({ where: { domain: payload.shop } });
  if (!shop) {
    return { ok: false, message: "That store is no longer installed." };
  }

  let channels: OwnedChannel[];
  try {
    const accessToken = await exchangeCode(code);
    channels = await fetchOwnChannels(accessToken);
    // The grant exists only to answer "which channels do you own". Spend it
    // and hand it straight back.
    await revokeToken(accessToken);
  } catch (caught) {
    console.error("YouTube connection failed", caught);
    return {
      ok: false,
      message: "Could not complete the connection. Please try again.",
    };
  }

  if (channels.length === 0) {
    return {
      ok: false,
      message:
        "That Google account has no YouTube channel. Sign in with the account that owns your channel.",
    };
  }

  if (channels.length === 1) {
    await attachVerifiedChannel(shop.id, channels[0]);
    return { ok: true, channelTitle: channels[0].title };
  }

  // More than one channel: let the merchant choose. The list is signed so the
  // follow-up request cannot smuggle in a channel Google never returned —
  // by then the access token is gone and we could not re-check.
  return {
    ok: "choose",
    choice: signState({ shop: shop.domain, channels, ts: Date.now() }),
    channels,
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<Result> => {
  const form = await request.formData();
  const choice = String(form.get("choice") ?? "");
  const channelId = String(form.get("channelId") ?? "");

  const payload = verifyState<ChoicePayload>(choice);
  if (!payload?.shop || !Array.isArray(payload.channels)) {
    return { ok: false, message: "That selection has expired. Start again." };
  }

  const channel = payload.channels.find((entry) => entry.id === channelId);
  if (!channel) {
    return { ok: false, message: "Pick one of your channels." };
  }

  const shop = await prisma.shop.findUnique({ where: { domain: payload.shop } });
  if (!shop) {
    return { ok: false, message: "That store is no longer installed." };
  }

  await attachVerifiedChannel(shop.id, channel);
  return { ok: true, channelTitle: channel.title };
};

const page: React.CSSProperties = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  maxWidth: 460,
  margin: "0 auto",
  padding: "72px 24px",
  textAlign: "center",
  lineHeight: 1.6,
};

export default function YouTubeCallback() {
  const loaded = useLoaderData<typeof loader>();
  const submitted = useActionData<typeof action>();
  const result = submitted ?? loaded;

  if (result.ok === "choose") {
    return (
      <main style={{ ...page, textAlign: "left" }}>
        <h1 style={{ fontSize: 22, margin: "0 0 12px", textAlign: "center" }}>
          Choose a channel
        </h1>
        <p style={{ margin: "0 0 20px", color: "#5c6b70", textAlign: "center" }}>
          Your Google account owns more than one channel.
        </p>
        <Form method="post">
          <input type="hidden" name="choice" value={result.choice} />
          {result.channels.map((channel) => (
            <label
              key={channel.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                padding: 12,
                marginBottom: 8,
                border: "1px solid #c9d2d4",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              <input type="radio" name="channelId" value={channel.id} required />
              {channel.thumbnailUrl && (
                <img
                  src={channel.thumbnailUrl}
                  alt=""
                  width={32}
                  height={32}
                  style={{ borderRadius: "50%", display: "block" }}
                />
              )}
              <span>{channel.title}</span>
            </label>
          ))}
          <button
            type="submit"
            style={{
              font: "inherit",
              width: "100%",
              padding: "9px 18px",
              marginTop: 12,
              borderRadius: 6,
              border: "1px solid #c9d2d4",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Connect this channel
          </button>
        </Form>
      </main>
    );
  }

  return (
    <main style={page}>
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>
        {result.ok ? "YouTube connected" : "Couldn't connect YouTube"}
      </h1>
      <p style={{ margin: "0 0 20px", color: "#5c6b70" }}>
        {result.ok
          ? `Connected to ${result.channelTitle}. You can close this tab and return to Shopdart to import your videos.`
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
