import type { Metadata, Viewport } from "next";

/**
 * Canonical origin for the marketing site. Everything that emits a URL — `metadataBase`,
 * `openGraph.url`, the canonical link, the sitemap, robots, and the JSON-LD — resolves against
 * this single constant so they can never drift apart. The apex (`webhook.co`) 301-redirects here
 * (that edge redirect ships with the CD slice); `api.` and the `wbhk.my` ingestion hosts live on
 * their own hostnames, so the marketing site owns `www.` cleanly.
 */
export const SITE_URL = "https://www.webhook.co";

// The hero headline doubles as the SEO title. The <title> appends the brand with the same
// em-dash delimiter as the inner-page template (`%s — webhook.co`); og:/twitter: titles stay the
// bare headline since og:site_name already carries the brand.
const headline = "The webhook platform built for the agent era";
const description =
  "Capture any webhook, inspect every request, and replay it to localhost. " +
  "Then hand your agents an event they can act on. MCP-native. Private by default.";

// 1200×630 social card (public/og.png). Referenced explicitly (not via the app/ file convention)
// so the og:image and twitter:image URLs are predictable and assertable — both resolve to an
// absolute www URL via `metadataBase`, which is what JS-less social scrapers require.
const ogImage = {
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: "webhook.co — the webhook platform built for the agent era.",
};

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${headline} — webhook.co`, template: "%s — webhook.co" },
  description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "webhook.co",
    title: headline,
    description,
    locale: "en_US",
    images: [ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title: headline,
    description,
    images: [ogImage.url],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const siteViewport: Viewport = {
  // The marketing site is light-only by design; the browser chrome follows suit.
  colorScheme: "light",
  themeColor: "#f8fafc",
};
