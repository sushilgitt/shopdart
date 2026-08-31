import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { deriveCode } from "./crypto.server";
import {
  fetchOEmbed,
  handleFromAuthorUrl,
  parseHandle,
  resolvePost,
  sameHandle,
  type TikTokPost,
} from "./tiktok.server";

/**
 * TikTok account ownership.
 *
 * Every other source in this app can prove ownership through the platform
 * itself: Instagram hands back a token scoped to the merchant's own media, and
 * YouTube answers `channels.list?mine=true` for whoever signed in. TikTok can
 * do neither without a developer app that merchants cannot be asked to create,
 * and that this project cannot register from where it is maintained.
 *
 * So ownership is proven the way YouTube's fallback path proves it, and the way
 * a DNS TXT record proves a domain: by asking for something only the account
 * holder can publish. The merchant puts a derived code in the caption of one of
 * their own posts, and oEmbed reads that caption back. Editing a caption
 * requires being signed into the account, so a stranger cannot pass this.
 *
 * Like every check of that shape it proves control at this moment rather than
 * forever, which is the accepted limitation of the pattern.
 *
 * The gate is enforced here rather than at the route, so no future caller can
 * reach an import without passing through it.
 */

export class TikTokNotConnectedError extends Error {
  constructor() {
    super("This store has not connected a TikTok account.");
    this.name = "TikTokNotConnectedError";
  }
}

export class TikTokNotVerifiedError extends Error {
  constructor() {
    super("This TikTok account has not been verified as yours.");
    this.name = "TikTokNotVerifiedError";
  }
}

/** The post resolved to a different account than the verified one. */
export class TikTokOwnershipError extends Error {
  constructor(readonly expected: string, readonly actual: string | null) {
    super(
      actual
        ? `That post belongs to @${actual}, not @${expected}.`
        : `That post could not be confirmed as belonging to @${expected}.`,
    );
    this.name = "TikTokOwnershipError";
  }
}

/**
 * TikTok could not be reached.
 *
 * Its own error type because it is the one failure that must not be treated as
 * "not yours". Ownership here is established by reading TikTok, so when TikTok
 * is unreachable the honest answer is "we cannot tell right now" — and the safe
 * one is to refuse. Silently allowing the import would reopen exactly the hole
 * this module exists to close.
 */
export class TikTokUnreachableError extends Error {
  constructor() {
    super("Shopdart could not reach TikTok to check that post. Try again shortly.");
    this.name = "TikTokUnreachableError";
  }
}

/**
 * The code a merchant puts in a post caption to prove control of the account.
 *
 * Deterministic per (shop, handle), so a pending claim needs no stored row and
 * cannot expire halfway through. Derived from the app key via HMAC, so it
 * cannot be computed by someone who merely knows the shop and the handle.
 */
export function verificationCodeFor(shopId: string, username: string): string {
  return `shopdart-verify-${deriveCode(`tt:${shopId}:${username.toLowerCase()}`)}`;
}

/**
 * Records a claim on an account — explicitly NOT proof of ownership.
 *
 * Anyone can name any handle, so this writes it with `ttVerifiedAt` cleared.
 * Importing stays closed until `verifyAccountByCaption` succeeds.
 */
export async function beginAccountClaim(
  shop: Shop,
  input: string,
): Promise<{ username: string; code: string } | null> {
  const username = parseHandle(input);
  if (!username) return null;

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      ttUsername: username,
      // A fresh claim is unverified even if a previous account was verified.
      ttVerifiedAt: null,
    },
  });

  return { username, code: verificationCodeFor(shop.id, username) };
}

/**
 * Confirms the claim by finding the code in the caption of one of the
 * account's own posts.
 *
 * Two things must both hold, and checking only one of them would be useless:
 *
 *  - The caption carries the code. Publishing that requires being signed into
 *    the account.
 *  - oEmbed reports the post's author as the claimed handle. Without this a
 *    merchant could paste someone else's post and pass by putting the code in
 *    a caption they do control elsewhere.
 *
 * The handle in the URL path is deliberately not trusted for the author check.
 * TikTok serves a post by its numeric id, so `/@anyone/video/<id>` resolves
 * regardless of whose name sits in the path. `author_url` comes from TikTok.
 */
export async function verifyAccountByCaption(
  shop: Shop,
  postUrl: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!shop.ttUsername) throw new TikTokNotConnectedError();

  const post = await resolvePost(postUrl);
  if (!post) {
    return {
      ok: false,
      reason:
        "That doesn't look like a TikTok post link. It should look like https://www.tiktok.com/@yourname/video/1234567890.",
    };
  }

  const meta = await fetchOEmbed(post.url);
  if (!meta) throw new TikTokUnreachableError();

  const author = handleFromAuthorUrl(meta.authorUrl);
  if (!sameHandle(author, shop.ttUsername)) {
    return {
      ok: false,
      reason: author
        ? `That post belongs to @${author}, not @${shop.ttUsername}.`
        : `TikTok did not report an author for that post, so it cannot be checked.`,
    };
  }

  const code = verificationCodeFor(shop.id, shop.ttUsername);
  if (!meta.title || !meta.title.includes(code)) {
    return {
      ok: false,
      reason:
        "That post's caption doesn't contain the code yet. Add it, wait a moment for TikTok to update, then try again.",
    };
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { ttVerifiedAt: new Date() },
  });

  return { ok: true };
}

/** Clears the connection, so a different account can be claimed. */
export async function disconnectTikTok(shopId: string): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: { ttUsername: null, ttVerifiedAt: null, ttLastSyncedAt: null },
  });
}

/**
 * The single gate every TikTok import passes through.
 *
 * Returns the resolved post only when the shop has a verified account and
 * TikTok itself confirms the post belongs to it. Throws otherwise — there is
 * deliberately no "allow anyway" branch, because every failure here means the
 * one question this function exists to answer went unanswered.
 *
 * Called from the upload endpoint rather than from the page, so the check
 * cannot be skipped by posting to the API directly.
 */
export async function assertOwnedPost(
  shop: Shop,
  postUrl: string,
): Promise<TikTokPost> {
  if (!shop.ttUsername) throw new TikTokNotConnectedError();
  if (!shop.ttVerifiedAt) throw new TikTokNotVerifiedError();

  const post = await resolvePost(postUrl);
  if (!post) {
    throw new Error(
      "That doesn't look like a TikTok post link. It should look like https://www.tiktok.com/@yourname/video/1234567890.",
    );
  }

  // Cheap pre-check on the handle in the URL. Not authoritative — TikTok
  // resolves a post by its numeric id whatever name precedes it — but it
  // catches an honest paste of someone else's link before spending a request.
  if (post.username && !sameHandle(post.username, shop.ttUsername)) {
    throw new TikTokOwnershipError(shop.ttUsername, post.username);
  }

  const meta = await fetchOEmbed(post.url);
  if (!meta) throw new TikTokUnreachableError();

  // The authoritative check: TikTok's own answer about who posted this.
  const author = handleFromAuthorUrl(meta.authorUrl);
  if (!sameHandle(author, shop.ttUsername)) {
    throw new TikTokOwnershipError(shop.ttUsername, author);
  }

  return post;
}

/** Caption of an owned post, for prefilling the library title. */
export async function captionFor(postUrl: string): Promise<string | null> {
  const meta = await fetchOEmbed(postUrl);
  return meta?.title ?? null;
}

export async function markSynced(shopId: string): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: { ttLastSyncedAt: new Date() },
  });
}
