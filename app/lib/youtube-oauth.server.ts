/**
 * Google OAuth — used once, purely to prove channel ownership.
 *
 * An API key says nothing about who is asking, so a merchant could otherwise
 * attach any public channel by typing its handle. Signing in with Google and
 * calling `channels.list?mine=true` makes Google itself answer the question:
 * the response contains only channels that account owns.
 *
 * The access token is deliberately NOT stored. It is used for one request and
 * discarded, and `access_type=online` means Google never issues a refresh
 * token in the first place. Browsing and importing afterwards run on the
 * server-side API key against public data, so there is no credential to
 * encrypt, rotate or silently let expire.
 */

const AUTH_HOST = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_HOST = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * The narrowest scope that returns `channels.list?mine=true`. It is classified
 * sensitive rather than restricted, so verification needs Google's review but
 * no third-party security assessment.
 */
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, " +
        "GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI &&
      !process.env.GOOGLE_CLIENT_ID.startsWith("CHANGEME"),
  );
}

export function authorizeUrl(
  state: string,
  config?: GoogleOAuthConfig,
): string {
  const cfg = config ?? googleOAuthConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    // No refresh token: the grant is spent immediately and never reused.
    access_type: "online",
    // Merchants often hold several Google accounts; force the picker rather
    // than silently using whichever they happen to be signed into.
    prompt: "select_account",
  });
  return `${AUTH_HOST}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export async function exchangeCode(
  code: string,
  config?: GoogleOAuthConfig,
): Promise<string> {
  const cfg = config ?? googleOAuthConfig();

  const response = await fetch(TOKEN_HOST, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Google code exchange failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  return data.access_token;
}

export interface OwnedChannel {
  id: string;
  title: string;
  uploadsPlaylistId: string;
  thumbnailUrl: string | null;
}

interface MineResponse {
  items?: {
    id: string;
    snippet?: {
      title?: string;
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
    };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }[];
}

/**
 * Channels the signed-in account owns.
 *
 * `mine=true` is the entire ownership check — Google resolves it from the
 * bearer token, so there is no handle for the merchant to type and no way to
 * name a channel they do not control.
 */
export async function fetchOwnChannels(
  accessToken: string,
): Promise<OwnedChannel[]> {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    mine: "true",
    maxResults: "50",
  });

  const response = await fetch(`${API_BASE}/channels?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Google channels.list failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as MineResponse;

  return (data.items ?? [])
    .filter((item) => item.contentDetails?.relatedPlaylists?.uploads)
    .map((item) => ({
      id: item.id,
      title: item.snippet?.title ?? "",
      uploadsPlaylistId: item.contentDetails!.relatedPlaylists!.uploads!,
      thumbnailUrl:
        item.snippet?.thumbnails?.medium?.url ??
        item.snippet?.thumbnails?.default?.url ??
        null,
    }));
}

/**
 * Best-effort revocation of the one-time grant.
 *
 * The token is discarded either way, but revoking removes DPS from the
 * merchant's Google account permissions page rather than leaving an entry
 * there implying ongoing access we do not have.
 */
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
    });
  } catch (error) {
    console.error("Google token revoke failed", error);
  }
}
