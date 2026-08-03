import { CONTACT_EMAIL, LegalPage, Section, listStyle } from "../lib/legal-page";

/** Public terms of service: /terms */
export const meta = () => [
  { title: "Terms of Service — Shopdart" },
  {
    name: "description",
    content: "The terms under which merchants may use Shopdart.",
  },
];

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      intro="These terms govern use of Shopdart. By installing the app on your Shopify store you agree to them."
    >
      <Section heading="The service">
        <p style={{ margin: 0 }}>
          Shopdart lets you import videos from sources you control, tag your
          products on them, and display them on your Shopify storefront as
          shoppable video widgets.
        </p>
      </Section>

      <Section heading="Your content and your responsibility for it">
        <p style={{ margin: "0 0 8px" }}>
          You keep ownership of everything you upload or import. You grant us
          only the permission needed to host, encode and deliver it to your
          storefront.
        </p>
        <p style={{ margin: 0 }}>
          You are responsible for having the right to use every video you import,
          including any music, footage or likeness within it. Do not import
          content belonging to someone else without their permission. We verify
          that a connected Instagram or YouTube account is yours, but we cannot
          verify the rights to the material inside each video.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <ul style={listStyle}>
          <li>Do not use Shopdart for unlawful, deceptive or infringing content</li>
          <li>
            Do not attempt to circumvent plan limits, or to inflate or falsify
            usage and analytics
          </li>
          <li>
            Do not probe, overload or interfere with the service or its
            infrastructure
          </li>
        </ul>
      </Section>

      <Section heading="Plans and billing">
        <p style={{ margin: "0 0 8px" }}>
          Paid plans are billed through Shopify, and Shopify handles charges,
          trials and refunds under their terms. Plans include a monthly allowance
          of video views and a maximum library size.
        </p>
        <p style={{ margin: 0 }}>
          If you exceed your view allowance, your videos keep playing — we do not
          switch off a live storefront over billing. Views beyond the allowance
          simply stop counting until the next period. You can change or cancel a
          plan at any time from your Shopify admin.
        </p>
      </Section>

      <Section heading="Third-party services">
        <p style={{ margin: 0 }}>
          Shopdart depends on Shopify, Meta (Instagram) and Google (YouTube).
          Your use of those integrations is also subject to their terms, and
          changes or outages on their side may affect availability. Videos from
          YouTube play in YouTube&rsquo;s own embedded player.
        </p>
      </Section>

      <Section heading="Availability">
        <p style={{ margin: 0 }}>
          We aim for high availability but do not guarantee uninterrupted
          service. Storefront widget data is served from a cache designed to keep
          your videos playing even if our servers are unavailable.
        </p>
      </Section>

      <Section heading="Termination">
        <p style={{ margin: 0 }}>
          You may uninstall at any time, which stops all processing. We may
          suspend an account that breaches these terms. After uninstall your
          content is retained briefly so a reinstall does not lose your library,
          then permanently deleted.
        </p>
      </Section>

      <Section heading="Liability">
        <p style={{ margin: 0 }}>
          Shopdart is provided &ldquo;as is&rdquo;, without warranties of any
          kind. To the extent permitted by law, our total liability arising from
          your use of the app is limited to the amount you paid us in the twelve
          months before the claim.
        </p>
      </Section>

      <Section heading="Contact">
        <p style={{ margin: 0 }}>
          Questions about these terms:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </Section>
    </LegalPage>
  );
}
