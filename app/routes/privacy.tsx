import { CONTACT_EMAIL, LegalPage, Section, listStyle } from "../lib/legal-page";

/**
 * Public privacy policy: /privacy
 *
 * Required by Meta before an app can access the Instagram API, by Google for
 * sensitive-scope verification, and by Shopify for an App Store listing.
 *
 * Written from what the code actually does rather than from a template. Every
 * item below corresponds to a real field or call — reviewers reject generic
 * boilerplate, and a policy that overstates what is collected is as wrong as
 * one that understates it.
 */
export const meta = () => [
  { title: "Privacy Policy — DPS" },
  {
    name: "description",
    content:
      "How DPS collects, uses and stores data for merchants and shoppers.",
  },
];

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro="DPS turns a merchant's own Instagram reels and YouTube videos into shoppable videos on their Shopify storefront. This policy explains exactly what we collect, why, and how long we keep it."
    >
      <Section heading="Who we are">
        <p style={{ margin: 0 }}>
          DPS is a Shopify application operated by the developer contactable
          at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. In data
          protection terms, the merchant installing DPS is the controller of
          their store and shopper data; DPS acts as a processor on their
          behalf.
        </p>
      </Section>

      <Section heading="Store data we collect">
        <p style={{ margin: "0 0 8px" }}>
          When a merchant installs DPS, we read the following from the
          Shopify Admin API and store it:
        </p>
        <ul style={listStyle}>
          <li>Store domain, name, contact email, currency, country and timezone</li>
          <li>
            Product title, handle, image, price and variant list — but only for
            products the merchant explicitly tags on a video
          </li>
        </ul>
        <p style={{ margin: 0 }}>
          Product details are cached because the storefront reads a static file
          and cannot query Shopify. We request the <code>read_products</code>{" "}
          scope only. We do not read customer records, and we never receive
          payment information.
        </p>
      </Section>

      <Section heading="Instagram data">
        <p style={{ margin: "0 0 8px" }}>
          If a merchant connects an Instagram account they own, we request
          read-only access (<code>instagram_business_basic</code>) and store:
        </p>
        <ul style={listStyle}>
          <li>Instagram user ID and username</li>
          <li>
            A long-lived access token, encrypted at rest with AES-256-GCM
          </li>
          <li>
            For reels the merchant chooses to import: the caption, permalink and
            a copy of the video file, re-hosted on our video CDN so it can be
            played on the storefront
          </li>
        </ul>
        <p style={{ margin: 0 }}>
          DPS cannot post, comment, message or delete anything on Instagram.
          A merchant may disconnect at any time, and removing DPS from their
          Instagram account also clears the connection here.
        </p>
      </Section>

      <Section heading="YouTube data">
        <p style={{ margin: "0 0 8px" }}>
          If a merchant connects a YouTube channel they own, we store the channel
          ID, channel name, and the ID, title, description, thumbnail and
          duration of videos they import.
        </p>
        <p style={{ margin: 0 }}>
          We do not download or re-host YouTube videos; they play in YouTube&rsquo;s
          embedded player, which is subject to{" "}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noreferrer noopener"
          >
            Google&rsquo;s Privacy Policy
          </a>
          . Where a merchant proves channel ownership by signing in with Google,
          the access token is used for that single check and then revoked and
          discarded — it is never stored. DPS&rsquo;s use of information received
          from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer noopener"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section heading="Shopper data">
        <p style={{ margin: "0 0 8px" }}>
          When a shopper views a video on a merchant&rsquo;s storefront, we record:
        </p>
        <ul style={listStyle}>
          <li>
            Which video and widget was shown, played, clicked or added to cart,
            and when
          </li>
          <li>
            A session identifier generated in the browser and{" "}
            <strong>stored only as a one-way hash</strong>, used to avoid
            counting the same person twice
          </li>
          <li>
            For an attributed order: the order ID, order total and currency
          </li>
        </ul>
        <p style={{ margin: 0 }}>
          We do not collect names, email addresses, postal addresses, IP
          addresses or payment details of shoppers. We do not use advertising
          cookies, do not build shopper profiles, and do not sell or share this
          data with anyone.
        </p>
      </Section>

      <Section heading="Who we share data with">
        <p style={{ margin: "0 0 8px" }}>
          We do not sell data. We use these processors solely to run the service:
        </p>
        <ul style={listStyle}>
          <li>
            <strong>Bunny.net</strong> — video encoding, storage and delivery for
            uploaded and Instagram-sourced videos
          </li>
          <li>
            <strong>Our hosting provider</strong> — application servers and the
            database, located in Europe
          </li>
          <li>
            <strong>Shopify</strong>, <strong>Meta</strong> and{" "}
            <strong>Google</strong> — only for the integrations described above
          </li>
        </ul>
      </Section>

      <Section heading="How long we keep it">
        <ul style={listStyle}>
          <li>
            Videos, tags and widgets are kept while the app is installed. If the
            merchant uninstalls, their content is retained briefly so a
            reinstall does not lose their library, then purged.
          </li>
          <li>
            Analytics events are retained for reporting and are not linked to any
            identifiable person.
          </li>
          <li>
            Access tokens are deleted immediately on disconnect or uninstall.
          </li>
        </ul>
      </Section>

      <Section heading="Your rights and how to exercise them">
        <p style={{ margin: "0 0 8px" }}>
          Under the GDPR, UK GDPR and CCPA you may request access to, correction
          of, or deletion of your data, and object to processing.
        </p>
        <ul style={listStyle}>
          <li>
            <strong>Merchants:</strong> email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, or
            uninstall the app to stop all processing.
          </li>
          <li>
            <strong>Shoppers:</strong> contact the store you visited. They are
            the controller of that data and we will act on their instruction.
          </li>
          <li>
            <strong>Instagram users:</strong> removing DPS from your
            Instagram account triggers our deauthorisation endpoint, which
            deletes the connection. A data deletion request additionally removes
            every video imported from your account.
          </li>
        </ul>
        <p style={{ margin: 0 }}>
          We respond to requests within 30 days.
        </p>
      </Section>

      <Section heading="Security">
        <p style={{ margin: 0 }}>
          All traffic is encrypted in transit over HTTPS. Access tokens are
          encrypted at rest. Webhooks from Shopify, Meta and our video provider
          are verified by signature before being acted upon, and unauthenticated
          requests are rejected.
        </p>
      </Section>

      <Section heading="Changes">
        <p style={{ margin: 0 }}>
          If this policy changes materially we will update the date at the top of
          this page and notify merchants in the app.
        </p>
      </Section>
    </LegalPage>
  );
}
