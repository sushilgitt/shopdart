import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM for data we must be able to read back — currently only Instagram
 * long-lived access tokens.
 *
 * ENCRYPTION_KEY is 32 bytes hex (64 chars). Generate with:
 *   openssl rand -hex 32
 *
 * Hex rather than base64 deliberately: Coolify rejects env values containing
 * `+`, `/` or `=`.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard
const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is not set — cannot encrypt stored tokens.");
  }
  const buf = Buffer.from(raw.trim(), "hex");
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes of hex (64 characters); got ${buf.length} bytes.`,
    );
  }
  return buf;
}

/** Returns `v1:<iv>:<authTag>:<ciphertext>`, all hex. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join(":");
}

export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Ciphertext is not in the expected v1 format.");
  }
  const [, ivHex, tagHex, dataHex] = parts;

  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Signed state, for OAuth round-trips
// ---------------------------------------------------------------------------

/**
 * Instagram redirects the browser straight back to us with no Shopify session
 * token, so the callback cannot call `authenticate.admin` to learn which shop
 * is connecting. The shop domain therefore rides along in the OAuth `state`
 * parameter — which means it must be signed, or anyone could bind their own
 * Instagram account to someone else's store.
 */
export function signState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyState<T = Record<string, unknown>>(
  state: string,
  maxAgeSeconds = 900,
): T | null {
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;

  const expected = createHmac("sha256", key()).update(body).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: T & { ts?: number };
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  // Bound the replay window even though the signature is valid.
  if (
    typeof parsed.ts !== "number" ||
    Date.now() - parsed.ts > maxAgeSeconds * 1000
  ) {
    return null;
  }

  return parsed;
}
