import type { Shop } from "@prisma/client";
import prisma from "../db.server";

/**
 * Returns the Shop row for a domain, creating it on first authenticated load.
 *
 * Shopify does not send an "app installed" webhook, so install-time
 * provisioning has to happen here. This also un-deletes a shop that
 * reinstalls: their videos and widgets are preserved, so a reinstall picks up
 * where they left off rather than starting empty.
 */
export async function ensureShop(domain: string): Promise<Shop> {
  const existing = await prisma.shop.findUnique({ where: { domain } });

  if (existing) {
    if (existing.uninstalledAt) {
      return prisma.shop.update({
        where: { domain },
        data: { uninstalledAt: null, installedAt: new Date() },
      });
    }
    return existing;
  }

  return prisma.shop.create({ data: { domain } });
}

/**
 * Marks a shop uninstalled without destroying its content.
 *
 * Deleting on uninstall is tempting but wrong: merchants uninstall to test
 * pricing or troubleshoot themes and reinstall within days. Losing their
 * tagged video library at that moment is unrecoverable and generates the
 * one-star reviews this category lives and dies by. A scheduled job purges
 * shops still uninstalled after the GDPR retention window.
 */
export async function markUninstalled(domain: string): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain, uninstalledAt: null },
    data: {
      uninstalledAt: new Date(),
      // Shopify destroys the WebPixel record on uninstall. Keeping the id would
      // make a reinstall skip registration and silently lose purchase
      // attribution, so forget it and let the next load register a fresh one.
      webPixelId: null,
    },
  });
}

/** Backfills shop profile fields from the Admin API after install. */
export async function updateShopProfile(
  domain: string,
  profile: {
    name?: string | null;
    email?: string | null;
    currencyCode?: string | null;
    countryCode?: string | null;
    timezone?: string | null;
  },
): Promise<void> {
  await prisma.shop.update({ where: { domain }, data: profile });
}
