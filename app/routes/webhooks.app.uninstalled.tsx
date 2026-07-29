import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markUninstalled } from "../lib/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhooks can fire more than once, and after the app is already gone.
  // Both calls below are idempotent.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Flag the shop rather than deleting it. Merchants reinstall often — after
  // testing pricing or debugging a theme — and destroying their tagged video
  // library at that moment is unrecoverable.
  await markUninstalled(shop);

  return new Response();
};
