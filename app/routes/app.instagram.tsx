import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { signState } from "../lib/crypto.server";
import { authorizeUrl, isInstagramConfigured } from "../lib/instagram.server";
import {
  InstagramNotConnectedError,
  InstagramTokenExpiredError,
  type BrowsableReel,
  browseReels,
  disconnectInstagram,
  importReels,
} from "../lib/instagram-sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const connected = Boolean(shop.igUserId && shop.igAccessToken);
  const configured = isInstagramConfigured();

  if (!connected || !configured) {
    return {
      configured,
      connected: false as const,
      username: null,
      expiresAt: null,
      reels: [] as BrowsableReel[],
      loadError: null as string | null,
    };
  }

  let reels: BrowsableReel[] = [];
  let loadError: string | null = null;
  try {
    reels = await browseReels(shop);
  } catch (error) {
    if (error instanceof InstagramTokenExpiredError) {
      loadError =
        "Your Instagram connection expired. Reconnect to import new reels.";
    } else if (error instanceof InstagramNotConnectedError) {
      loadError = "Instagram is not connected.";
    } else {
      console.error("browseReels failed", error);
      loadError = "Could not load your reels from Instagram.";
    }
  }

  return {
    configured,
    connected: true as const,
    username: shop.igUsername,
    expiresAt: shop.igTokenExpiresAt?.toISOString() ?? null,
    reels,
    loadError,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "connect") {
    try {
      const state = signState({ shop: shop.domain, ts: Date.now() });
      return { ok: true as const, url: authorizeUrl(state) };
    } catch (error) {
      console.error("authorizeUrl failed", error);
      return {
        ok: false as const,
        error: "Instagram isn't configured yet. Add your Meta app credentials.",
      };
    }
  }

  if (intent === "disconnect") {
    await disconnectInstagram(shop.id);
    return { ok: true as const, disconnected: true };
  }

  if (intent === "import") {
    const ids = form.getAll("mediaId").map(String).filter(Boolean);
    if (ids.length === 0) {
      return { ok: false as const, error: "Select at least one reel." };
    }
    try {
      const result = await importReels(shop, ids);
      return { ok: true as const, result };
    } catch (error) {
      if (error instanceof InstagramTokenExpiredError) {
        return {
          ok: false as const,
          error: "Your Instagram connection expired. Reconnect and try again.",
        };
      }
      console.error("importReels failed", error);
      return { ok: false as const, error: "Import failed. Please try again." };
    }
  }

  return { ok: false as const, error: "Unknown action" };
};

export default function Instagram() {
  const { configured, connected, username, expiresAt, reels, loadError } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Guards against reopening the tab when the component re-renders with the
  // same fetcher payload.
  const openedUrl = useRef<string | null>(null);

  const busy = fetcher.state !== "idle";
  const importable = reels.filter((reel) => !reel.imported);

  const connect = () => {
    fetcher.submit({ intent: "connect" }, { method: "POST" });
  };

  const authUrl =
    fetcher.data?.ok && "url" in fetcher.data ? fetcher.data.url : null;

  // The authorize screen must load top-level — Instagram refuses to render
  // inside the embedded admin iframe — so it opens in its own tab. Done in an
  // effect rather than during render: `window` doesn't exist during SSR, and
  // opening a tab is a side effect.
  useEffect(() => {
    if (!authUrl || authUrl === openedUrl.current) return;
    openedUrl.current = authUrl;
    window.open(authUrl, "_blank", "noopener,noreferrer");
  }, [authUrl]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const result =
    fetcher.data?.ok && "result" in fetcher.data ? fetcher.data.result : null;
  const error =
    fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  return (
    <s-page heading="Instagram">
      {connected && (
        <s-button
          slot="primary-action"
          onClick={() => {
            const body = new FormData();
            body.set("intent", "import");
            selected.forEach((id) => body.append("mediaId", id));
            fetcher.submit(body, { method: "POST" });
            setSelected(new Set());
          }}
          {...(selected.size === 0 || busy ? { disabled: true } : {})}
        >
          {selected.size > 0 ? `Import ${selected.size} reel${selected.size === 1 ? "" : "s"}` : "Import selected"}
        </s-button>
      )}

      {!configured && (
        <s-section heading="Instagram isn't set up yet">
          <s-paragraph>
            DPS needs Meta app credentials before merchants can connect
            their accounts. Add INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and
            INSTAGRAM_REDIRECT_URI.
          </s-paragraph>
        </s-section>
      )}

      {configured && !connected && (
        <s-section heading="Connect your Instagram account">
          <s-paragraph>
            DPS imports reels from your own Instagram Business or Creator
            account. You&rsquo;ll sign in with Instagram directly — no Facebook Page
            required.
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              DPS only reads your media. It cannot post, comment or message
              on your behalf.
            </s-text>
          </s-paragraph>
          <s-button onClick={connect} {...(busy ? { loading: true } : {})}>
            Connect Instagram
          </s-button>
        </s-section>
      )}

      {error && (
        <s-section heading="Something went wrong">
          <s-paragraph>{error}</s-paragraph>
        </s-section>
      )}

      {result && (
        <s-section heading="Import finished">
          <s-paragraph>
            {result.imported} imported
            {result.skipped > 0 ? `, ${result.skipped} already in your library` : ""}
            {result.failed > 0 ? `, ${result.failed} failed` : ""}.
          </s-paragraph>
          {result.errors.length > 0 && (
            <s-paragraph>
              <s-text color="subdued">{result.errors.join(" ")}</s-text>
            </s-paragraph>
          )}
          <s-paragraph>
            <s-text color="subdued">
              Imported reels appear under Videos while Bunny Stream encodes them.
            </s-text>
          </s-paragraph>
        </s-section>
      )}

      {loadError && (
        <s-section heading="Couldn't load your reels">
          <s-paragraph>{loadError}</s-paragraph>
          <s-button onClick={connect}>Reconnect Instagram</s-button>
        </s-section>
      )}

      {connected && !loadError && (
        <s-section
          heading={
            importable.length > 0
              ? `${importable.length} reel${importable.length === 1 ? "" : "s"} available`
              : "No new reels"
          }
        >
          {reels.length === 0 ? (
            <s-paragraph>
              We couldn&rsquo;t find any reels on @{username}. Post a reel on Instagram
              and it will show up here.
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="small-200">
              {reels.map((reel) => (
                <s-box
                  key={reel.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background={selected.has(reel.id) ? "subdued" : undefined}
                >
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {reel.thumbnailUrl && (
                        <img
                          src={reel.thumbnailUrl}
                          alt=""
                          width={48}
                          height={64}
                          style={{
                            objectFit: "cover",
                            borderRadius: 4,
                            display: "block",
                          }}
                        />
                      )}
                      <s-stack direction="block" gap="small-200">
                        <s-text type="strong">
                          {truncate(reel.caption) || "Untitled reel"}
                        </s-text>
                        <s-text color="subdued">
                          {reel.timestamp
                            ? new Date(reel.timestamp).toLocaleDateString()
                            : ""}
                          {reel.imported ? " · Already imported" : ""}
                        </s-text>
                      </s-stack>
                    </s-stack>
                    {reel.imported ? (
                      <s-text color="subdued">In library</s-text>
                    ) : (
                      <s-button
                        variant="secondary"
                        onClick={() => toggle(reel.id)}
                      >
                        {selected.has(reel.id) ? "Selected" : "Select"}
                      </s-button>
                    )}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-section>
      )}

      {connected && (
        <s-section slot="aside" heading="Connected account">
          <s-paragraph>
            <s-text type="strong">@{username}</s-text>
          </s-paragraph>
          {expiresAt && (
            <s-paragraph>
              <s-text color="subdued">
                Connection renews automatically. Valid until{" "}
                {new Date(expiresAt).toLocaleDateString()}.
              </s-text>
            </s-paragraph>
          )}
          <Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <s-button type="submit" variant="tertiary">
              Disconnect
            </s-button>
          </Form>
        </s-section>
      )}
    </s-page>
  );
}

function truncate(caption?: string): string {
  if (!caption) return "";
  const line = caption.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
