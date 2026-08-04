import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

/**
 * Public marketing page: /
 *
 * Not decoration. Google requires a publicly reachable homepage that describes
 * the app and links to its privacy policy before granting sensitive-scope
 * verification, and Shopify and Meta reviewers both land here. It must be
 * readable without logging in, which is why the merchant login form is
 * secondary to the description rather than the whole page.
 */
export const meta = () => [
  { title: "Shopdart — Shoppable videos for Shopify" },
  {
    name: "description",
    content:
      "Turn your Instagram reels and YouTube videos into shoppable videos on your Shopify store. Tag products, let shoppers buy from inside the player.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

const FEATURES = [
  {
    title: "Bring in videos you already have",
    body: "Import reels from your own Instagram account, videos from your own YouTube channel, or upload files directly. We verify you own the account before anything is imported.",
  },
  {
    title: "Tag the products that appear",
    body: "Pick products from your catalogue and pin them to a video. Shoppers choose a size or colour and add to cart without leaving the page.",
  },
  {
    title: "Place it anywhere on your storefront",
    body: "Carousel, gallery, stories bar, product page block, floating player or popup — added through your theme editor, no code.",
  },
  {
    title: "See what actually sells",
    body: "Views, product clicks and add-to-carts per video, with revenue attributed to the video that drove the order rather than estimated.",
  },
  {
    title: "Built not to slow your store down",
    body: "No framework on the storefront, nothing downloaded before a shopper scrolls to it, and layout space reserved so the page never jumps.",
  },
];

const link: React.CSSProperties = { color: "#1f2933" };

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        maxWidth: 760,
        margin: "0 auto",
        padding: "72px 24px 96px",
        lineHeight: 1.65,
        color: "#1f2933",
      }}
    >
      <h1 style={{ fontSize: 38, lineHeight: 1.15, margin: "0 0 16px" }}>
        Shoppable videos for Shopify
      </h1>
      <p style={{ fontSize: 19, color: "#5c6b70", margin: "0 0 32px" }}>
        Shopdart turns the videos you already post — Instagram reels, YouTube
        videos, or your own uploads — into shoppable videos on your storefront.
        Shoppers tap a product in the player and buy without leaving the page.
      </p>

      {showForm && (
        <Form
          method="post"
          action="/auth/login"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
            <span>Your Shopify store domain</span>
            <input
              type="text"
              name="shop"
              placeholder="my-store.myshopify.com"
              style={{
                font: "inherit",
                padding: "8px 10px",
                minWidth: 260,
                border: "1px solid #c9d2d4",
                borderRadius: 6,
              }}
            />
          </label>
          <button
            type="submit"
            style={{
              font: "inherit",
              padding: "9px 18px",
              border: "1px solid #1f2933",
              borderRadius: 6,
              background: "#1f2933",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Open Shopdart
          </button>
        </Form>
      )}
      <p style={{ fontSize: 14, color: "#5c6b70", margin: "0 0 48px" }}>
        Already installed? Enter your store domain to open the app.
      </p>

      <h2 style={{ fontSize: 22, margin: "0 0 20px" }}>What it does</h2>
      {FEATURES.map((feature) => (
        <section key={feature.title} style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 17, margin: "0 0 4px" }}>{feature.title}</h3>
          <p style={{ margin: 0, color: "#5c6b70" }}>{feature.body}</p>
        </section>
      ))}

      <h2 style={{ fontSize: 22, margin: "40px 0 12px" }}>
        What we access, and what we don&rsquo;t
      </h2>
      <p style={{ margin: "0 0 12px", color: "#5c6b70" }}>
        Shopdart reads your products so you can tag them, and reads media from
        the Instagram or YouTube accounts you connect. It cannot post, comment
        or change anything on those accounts, and it never reads your customer
        records or payment details. Full detail is in the{" "}
        <a href="/privacy" style={link}>
          privacy policy
        </a>
        .
      </p>

      <hr
        style={{ margin: "48px 0 24px", border: 0, borderTop: "1px solid #e4e9eb" }}
      />
      <p style={{ fontSize: 14, color: "#5c6b70" }}>
        <a href="/privacy" style={link}>
          Privacy Policy
        </a>{" "}
        ·{" "}
        <a href="/terms" style={link}>
          Terms of Service
        </a>
      </p>
    </main>
  );
}
