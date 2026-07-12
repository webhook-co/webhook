import type { Metadata, Viewport } from "next";

/**
 * Canonical origin for the marketing site. Everything that emits a URL — `metadataBase`,
 * `openGraph.url`, the canonical link, the sitemap, robots, and the JSON-LD — resolves against
 * this single constant so they can never drift apart. The apex (`webhook.co`) 301-redirects here
 * (that edge redirect ships with the CD slice); `api.` and the `wbhk.my` ingestion hosts live on
 * their own hostnames, so the marketing site owns `www.` cleanly.
 */
export const SITE_URL = "https://www.webhook.co";

/**
 * A site-absolute route path → its absolute canonical URL. The one place the `"/"`→bare-origin
 * special-case lives, so `pageMetadata` (canonical + og:url) and `sitemap.ts` (loc) can't drift —
 * the built-HTML SEO gate asserts og:url === canonical === the sitemap loc per page, and any
 * divergence between two copies of this mapping would red that gate or ship a wrong canonical.
 */
export function absoluteUrl(path: string): string {
  return path === "/" ? SITE_URL : `${SITE_URL}${path}`;
}

// The hero headline doubles as the SEO title. The <title> appends the brand with the same
// em-dash delimiter as the inner-page template (`%s — webhook.co`); og:/twitter: titles stay the
// bare headline since og:site_name already carries the brand.
const headline = "The webhook platform built for the agent era";
const description =
  "Capture the webhooks other services send you — inspect, verify, and replay to localhost. " +
  "Then hand your agents an event they can act on. MCP-native, private by default.";

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

/**
 * Per-page metadata for any inner route. Sets the page's own canonical AND a matching absolute
 * `openGraph.url`, then re-declares the full social card.
 *
 * This exists because Next inherits the root layout's `alternates.canonical: "/"` onto every page
 * that doesn't override it — so pricing/terms/privacy/dpa all canonicalised to the homepage, telling
 * Google they were duplicates of `/`. And because Next REPLACES (not deep-merges) a page-level
 * `openGraph`, a page that set only `url` would silently drop the og:image — so the helper always
 * returns the complete card. The built-HTML SEO gate enforces og:url === canonical per page; this is
 * the one place that guarantees it. Every inner page should build its metadata through here.
 */
export function pageMetadata({
  path,
  title,
  description: pageDescription,
  ogType = "website",
}: {
  /** Site-absolute route path, e.g. "/pricing" or "/product/verification". */
  path: string;
  /** Page title; the root template appends " — webhook.co", so don't repeat the brand. */
  title: string;
  description: string;
  ogType?: "website" | "article";
}): Metadata {
  const url = absoluteUrl(path);
  return {
    title,
    description: pageDescription,
    alternates: { canonical: path },
    openGraph: {
      type: ogType,
      url,
      siteName: "webhook.co",
      title,
      description: pageDescription,
      locale: "en_US",
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: pageDescription,
      images: [ogImage.url],
    },
  };
}
