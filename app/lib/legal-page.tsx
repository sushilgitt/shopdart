import type { ReactNode } from "react";

/**
 * Shared shell for the public marketing and legal pages.
 *
 * These are the only pages a reviewer or merchant sees without installing, and
 * every platform we submit to insists they exist: Meta and Shopify require a
 * reachable privacy policy, and Google additionally requires a homepage that
 * describes the app and links to both.
 *
 * Styles are inline rather than in a stylesheet so the pages render correctly
 * even if an asset fails to load — a blank privacy policy is a failed review.
 */

const LAST_UPDATED = "3 August 2026";
export const CONTACT_EMAIL = "sushilcodershive@gmail.com";

const shell: React.CSSProperties = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  maxWidth: 720,
  margin: "0 auto",
  padding: "56px 24px 96px",
  lineHeight: 1.65,
  color: "#1f2933",
};

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <main style={shell}>
      <a
        href="/"
        style={{ color: "#5c6b70", textDecoration: "none", fontSize: 14 }}
      >
        ← DPS
      </a>
      <h1 style={{ fontSize: 30, margin: "20px 0 8px", lineHeight: 1.2 }}>
        {title}
      </h1>
      <p style={{ color: "#5c6b70", fontSize: 14, margin: "0 0 32px" }}>
        Last updated {LAST_UPDATED}
      </p>
      {intro && <p style={{ margin: "0 0 24px" }}>{intro}</p>}
      {children}
      <hr
        style={{
          margin: "48px 0 24px",
          border: 0,
          borderTop: "1px solid #e4e9eb",
        }}
      />
      <p style={{ fontSize: 14, color: "#5c6b70" }}>
        <a href="/privacy" style={{ color: "#5c6b70" }}>
          Privacy
        </a>{" "}
        ·{" "}
        <a href="/terms" style={{ color: "#5c6b70" }}>
          Terms
        </a>
      </p>
    </main>
  );
}

export function Section({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 19, margin: "0 0 10px" }}>{heading}</h2>
      {children}
    </section>
  );
}

export const listStyle: React.CSSProperties = {
  margin: "0 0 12px",
  paddingLeft: 20,
};
