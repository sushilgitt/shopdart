import prisma from "../db.server";

/**
 * Web pixel registration.
 *
 * A web pixel extension is not live just because it was deployed. Shopify only
 * starts delivering customer events once a WebPixel record exists on the shop,
 * which the app has to create itself with `webPixelCreate`. Skipping this is a
 * silent failure: the extension shows up in the merchant's Customer events
 * settings as "Disconnected" and never fires, so purchases are never
 * attributed and the app looks exactly as broken as it did before the pixel
 * was added.
 */

/** The slice of the Admin API client this module needs. */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

const WEB_PIXEL_QUERY = `#graphql
  query shopdartWebPixel {
    webPixel {
      id
      settings
    }
  }
`;

const WEB_PIXEL_CREATE = `#graphql
  mutation shopdartWebPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel {
        id
        settings
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const WEB_PIXEL_UPDATE = `#graphql
  mutation shopdartWebPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel {
        id
        settings
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

interface UserError {
  code?: string | null;
  field?: string[] | null;
  message?: string | null;
}

interface WebPixelPayload {
  webPixel?: { id?: string | null; settings?: string | null } | null;
  userErrors?: UserError[] | null;
}

function describe(errors: UserError[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.code ?? "ERROR"}: ${error.message ?? ""}`)
    .join("; ");
}

/**
 * Ensures this shop has a WebPixel pointing at the current settings.
 *
 * Safe to call on every admin load. The registered id is cached on the Shop
 * row, so the common path costs one indexed read and no Admin API call at all.
 *
 * Never throws. A shop that cannot register a pixel — a transient API failure,
 * or a merchant on a plan without customer events — must still be able to open
 * the app; everything except purchase attribution works without it.
 */
export async function ensureWebPixel(
  admin: AdminGraphqlClient,
  shopDomain: string,
): Promise<string | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, webPixelId: true },
  });
  if (!shop) return null;
  if (shop.webPixelId) return shop.webPixelId;

  const settings = JSON.stringify({ shop: shopDomain });

  // A pixel may already exist from an earlier install — webPixelCreate fails
  // outright when one does, so look first rather than relying on the error.
  //
  // This lookup gets its own try/catch because "no pixel yet" is not reported
  // as an empty result. Shopify answers with `data: { webPixel: null }` AND a
  // GraphQL error, "No web pixel was found for this app", and the Admin client
  // throws on any GraphQL error. That is the normal state of every shop that
  // has never registered one — i.e. exactly the shops that need to. Letting it
  // reach the outer handler aborted registration before it ever attempted a
  // create, so the pixel was never installed and no purchase was ever
  // attributed.
  let existing: { id?: string | null; settings?: string | null } | null = null;
  try {
    const existingResponse = await admin.graphql(WEB_PIXEL_QUERY);
    const existingBody = (await existingResponse.json()) as {
      data?: { webPixel?: { id?: string | null; settings?: string | null } | null };
    };
    existing = existingBody?.data?.webPixel ?? null;
  } catch {
    existing = null;
  }

  try {
    let result: WebPixelPayload | undefined;

    if (existing?.id) {
      // Settings are rewritten rather than trusted: a pixel left over from a
      // previous install can carry a stale shop domain, and a pixel reporting
      // for the wrong shop is worse than one that is missing.
      if (existing.settings === settings) {
        await prisma.shop.update({
          where: { id: shop.id },
          data: { webPixelId: existing.id },
        });
        return existing.id;
      }

      const response = await admin.graphql(WEB_PIXEL_UPDATE, {
        variables: { id: existing.id, webPixel: { settings } },
      });
      const body = (await response.json()) as {
        data?: { webPixelUpdate?: WebPixelPayload };
      };
      result = body?.data?.webPixelUpdate;
    } else {
      const response = await admin.graphql(WEB_PIXEL_CREATE, {
        variables: { webPixel: { settings } },
      });
      const body = (await response.json()) as {
        data?: { webPixelCreate?: WebPixelPayload };
      };
      result = body?.data?.webPixelCreate;
    }

    const errors = result?.userErrors ?? [];
    if (errors.length > 0) {
      console.error(`Web pixel registration failed for ${shopDomain}: ${describe(errors)}`);
      return null;
    }

    const id = result?.webPixel?.id ?? null;
    if (!id) {
      console.error(`Web pixel registration returned no id for ${shopDomain}`);
      return null;
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: { webPixelId: id },
    });

    console.log(`Web pixel registered for ${shopDomain}: ${id}`);
    return id;
  } catch (error) {
    console.error(`Could not register the web pixel for ${shopDomain}`, error);
    return null;
  }
}

/** Forgets the cached pixel id, so the next admin load re-registers. */
export async function clearWebPixel(shopDomain: string): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shopDomain },
    data: { webPixelId: null },
  });
}
