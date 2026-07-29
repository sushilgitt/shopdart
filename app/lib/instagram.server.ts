/**
 * Instagram API with Instagram Login.
 *
 * Deliberately NOT "Instagram API with Facebook Login for Business", which
 * requires the merchant's Instagram account to be linked to a Facebook Page.
 * Most small Shopify merchants don't have one, and demanding it is a large
 * onboarding drop-off. Instagram Login authenticates against Instagram
 * directly and works for any Business or Creator account.
 *
 * Three different hosts are involved and they are not interchangeable:
 *   www.instagram.com    — user-facing authorize screen
 *   api.instagram.com    — short-lived code exchange
 *   graph.instagram.com  — long-lived tokens, refresh, and all media reads
 */

const AUTHORIZE_HOST = "https://www.instagram.com";
const TOKEN_HOST = "https://api.instagram.com";
const GRAPH_HOST = "https://graph.instagram.com";

/** Read-only access to the merchant's own media. Nothing else is requested. */
const SCOPES = ["instagram_business_basic"];

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function instagramConfig(): InstagramConfig {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri) {
    throw new Error(
      "Instagram is not configured. Set INSTAGRAM_APP_ID, " +
        "INSTAGRAM_APP_SECRET and INSTAGRAM_REDIRECT_URI.",
    );
  }
  return { appId, appSecret, redirectUri };
}

export function isInstagramConfigured(): boolean {
  return Boolean(
    process.env.INSTAGRAM_APP_ID &&
      process.env.INSTAGRAM_APP_SECRET &&
      process.env.INSTAGRAM_REDIRECT_URI &&
      !process.env.INSTAGRAM_APP_ID.startsWith("CHANGEME"),
  );
}

export function authorizeUrl(state: string, config?: InstagramConfig): string {
  const cfg = config ?? instagramConfig();
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE_HOST}/oauth/authorize?${params.toString()}`;
}

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: number | string;
  permissions?: string;
}

/** Exchanges the callback `code` for a short-lived token (about 1 hour). */
export async function exchangeCode(
  code: string,
  config?: InstagramConfig,
): Promise<{ accessToken: string; userId: string }> {
  const cfg = config ?? instagramConfig();

  const body = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
    code,
  });

  const response = await fetch(`${TOKEN_HOST}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Instagram code exchange failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as ShortLivedTokenResponse;
  return { accessToken: data.access_token, userId: String(data.user_id) };
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
}

/** Swaps a short-lived token for a 60-day one. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  config?: InstagramConfig,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const cfg = config ?? instagramConfig();
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: cfg.appSecret,
    access_token: shortLivedToken,
  });

  const response = await fetch(`${GRAPH_HOST}/access_token?${params.toString()}`);
  if (!response.ok) {
    throw new Error(
      `Instagram long-lived exchange failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as LongLivedTokenResponse;
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

/**
 * Refreshes a long-lived token for another 60 days.
 *
 * Meta requires the token to be at least 24 hours old and still valid. Once it
 * expires there is no recovery path — the merchant has to reconnect — so the
 * refresh job must run well before the deadline.
 */
export async function refreshLongLivedToken(
  longLivedToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: longLivedToken,
  });

  const response = await fetch(
    `${GRAPH_HOST}/refresh_access_token?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(
      `Instagram token refresh failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as LongLivedTokenResponse;
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

export interface InstagramProfile {
  id: string;
  username: string;
  accountType?: string;
  mediaCount?: number;
}

export async function fetchProfile(
  accessToken: string,
): Promise<InstagramProfile> {
  const params = new URLSearchParams({
    fields: "id,username,account_type,media_count",
    access_token: accessToken,
  });
  const response = await fetch(`${GRAPH_HOST}/me?${params.toString()}`);
  if (!response.ok) {
    throw new Error(
      `Instagram profile fetch failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as {
    id: string;
    username: string;
    account_type?: string;
    media_count?: number;
  };
  return {
    id: data.id,
    username: data.username,
    accountType: data.account_type,
    mediaCount: data.media_count,
  };
}

export interface InstagramMedia {
  id: string;
  mediaType: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  mediaProductType: "AD" | "FEED" | "STORY" | "REELS";
  /** Direct CDN URL to the file. Short-lived — ingest promptly. */
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
}

interface MediaApiItem {
  id: string;
  media_type: InstagramMedia["mediaType"];
  media_product_type: InstagramMedia["mediaProductType"];
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
}

const MEDIA_FIELDS = [
  "id",
  "media_type",
  "media_product_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "caption",
  "timestamp",
].join(",");

/**
 * Lists the merchant's reels, newest first.
 *
 * A reel is `media_type: VIDEO` *and* `media_product_type: REELS`. Filtering on
 * media_type alone also returns ordinary feed videos, which merchants do not
 * think of as reels.
 *
 * `media_url` on Instagram's CDN expires within hours, so anything imported
 * must be pulled into Bunny in the same request — persisting the URL and
 * fetching later reliably 403s.
 */
export async function fetchReels(
  accessToken: string,
  limit = 50,
): Promise<InstagramMedia[]> {
  const params = new URLSearchParams({
    fields: MEDIA_FIELDS,
    limit: String(Math.min(limit, 100)),
    access_token: accessToken,
  });

  const response = await fetch(`${GRAPH_HOST}/me/media?${params.toString()}`);
  if (!response.ok) {
    throw new Error(
      `Instagram media fetch failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as { data?: MediaApiItem[] };

  return (data.data ?? [])
    .filter(
      (item) =>
        item.media_product_type === "REELS" && item.media_type === "VIDEO",
    )
    .map((item) => ({
      id: item.id,
      mediaType: item.media_type,
      mediaProductType: item.media_product_type,
      mediaUrl: item.media_url,
      thumbnailUrl: item.thumbnail_url,
      permalink: item.permalink,
      caption: item.caption,
      timestamp: item.timestamp,
    }));
}

/** Re-reads one media item, to get a fresh media_url just before ingesting. */
export async function fetchMediaById(
  mediaId: string,
  accessToken: string,
): Promise<InstagramMedia | null> {
  const params = new URLSearchParams({
    fields: MEDIA_FIELDS,
    access_token: accessToken,
  });
  const response = await fetch(`${GRAPH_HOST}/${mediaId}?${params.toString()}`);
  if (!response.ok) return null;

  const item = (await response.json()) as MediaApiItem;
  return {
    id: item.id,
    mediaType: item.media_type,
    mediaProductType: item.media_product_type,
    mediaUrl: item.media_url,
    thumbnailUrl: item.thumbnail_url,
    permalink: item.permalink,
    caption: item.caption,
    timestamp: item.timestamp,
  };
}
