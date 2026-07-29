declare module "*.css";

// `s-app-nav` is rendered by App Bridge but is missing from
// @shopify/polaris-types, so TypeScript rejects it in JSX. Shopify's own
// template hits this too. Declaring it here keeps `npm run typecheck` clean
// without changing runtime behaviour — remove once the types ship it.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
