import { SITE_URL } from "@/app/metadata";

// JSON-LD baked into the static HTML at build time (server component — no client JS, cookieless).
// `Organization` feeds logo/name disambiguation in the Knowledge Panel; `WebSite` feeds the
// site-name treatment. We deliberately omit `SoftwareApplication` (its rich result is app-store
// shaped and would invite a fabricated rating) and `SearchAction` (there is no site search) —
// marking up only what is real and visible, per Google's structured-data policy.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "webhook.co",
      url: SITE_URL,
      // Google's Organization logo wants a raster format (it can drop SVGs), so this points at
      // the rendered PNG mark (public/logo.png) rather than the favicon SVG.
      logo: `${SITE_URL}/logo.png`,
      sameAs: ["https://github.com/webhook-co"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: "webhook.co",
      url: SITE_URL,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      // The payload is a static build-time constant; no user input is interpolated, so this is
      // the canonical, safe JSON-LD injection pattern for the App Router.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}
