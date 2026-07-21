import type { MetadataRoute } from "next";

/**
 * The route manifest — the single source of truth for every findable page on the marketing site.
 *
 * Four gates derive their page list from this manifest, so adding a route here makes it
 * automatically measured rather than silently un-gated:
 *   - `sitemap.ts` maps {@link sitemapRoutes} into `out/sitemap.xml`;
 *   - `scripts/check-seo-html.mjs` reads that emitted sitemap and runs the SEO head checks on EVERY
 *     listed page (not just the homepage — that hardcode is gone);
 *   - `scripts/check-export.mjs` reads it and asserts each page's HTML actually made it into `out/`;
 *   - `playwright/a11y.spec.ts` imports {@link a11yRoutes} and runs axe on each in a real browser.
 *
 * Before this manifest existed, all four inspected only `out/index.html` / a fixed file list, so a
 * new page shipped with zero SEO, export, or a11y coverage and nothing turned red. This is the fix:
 * one row here, gated everywhere.
 */
export interface MarketingRoute {
  /** Site-absolute path, no trailing slash except the root ("/", "/pricing", "/product/verification"). */
  readonly path: string;
  readonly changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  /** Sitemap priority, 0..1. The homepage is the anchor at 1. */
  readonly priority: number;
  /** Whether the real-browser axe gate scans this page. Every human-facing page should be true. */
  readonly a11y: boolean;
  /** Whether the page is advertised in `sitemap.xml`. Default true; only utility pages opt out. */
  readonly sitemap: boolean;
}

// Bump on substantive content changes. A fixed constant (not `new Date()`) so the emitted sitemap
// bytes are deterministic — the built-HTML SEO check asserts stable output.
export const SITEMAP_LAST_MODIFIED = "2026-07-21";

export const MARKETING_ROUTES: readonly MarketingRoute[] = [
  {
    path: "/",
    changeFrequency: "monthly",
    priority: 1,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/pricing",
    changeFrequency: "monthly",
    priority: 0.8,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/about",
    changeFrequency: "monthly",
    priority: 0.6,
    a11y: true,
    sitemap: true,
  },
  // The interactive signature verifier — an indexable tool page (unlike /play, which is a noindex
  // sandbox). High priority: it's the programmatic-SEO lane's differentiator (the recipe/verify asset
  // competitors lack) and runs the real engine entirely client-side.
  {
    path: "/verify",
    changeFrequency: "monthly",
    priority: 0.8,
    a11y: true,
    sitemap: true,
  },
  // Per-provider "test X webhooks locally" tutorials. Authored, not generated — see `lib/tutorials.ts`
  // for why a template cannot produce these. Each row makes its page sitemapped, SEO-checked, axe-scanned
  // in both themes, and overflow-checked on a phone; `tutorials.test.ts` asserts every tutorial has one.
  {
    path: "/test/discord",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/test/slack",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/test/stripe",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/test/github",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/test/shopify",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/test/atlassian_jira",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },

  // The /play sandbox: NOINDEX (sitemap:false + a robots noindex on the page) because it renders
  // ephemeral user-generated capture content that must never be indexed under the brand. Still a11y-
  // scanned. Not in the sitemap → the built-HTML SEO gate (which walks the sitemap) skips it, so its
  // noindex doesn't trip the "never noindex in production" rule.
  {
    path: "/play",
    changeFrequency: "monthly",
    priority: 0.5,
    a11y: true,
    sitemap: false,
  },
  // Product pages — the www surfaces the Product nav menu points at (so only "Docs" leaves for the
  // docs subdomain). priority just under the homepage: these are the pages we most want indexed.
  {
    path: "/product/capture-replay",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/product/verification",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/product/delivery",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/product/agent-triggers",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/security",
    changeFrequency: "monthly",
    priority: 0.7,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/terms",
    changeFrequency: "yearly",
    priority: 0.3,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/privacy",
    changeFrequency: "yearly",
    priority: 0.3,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/dpa",
    changeFrequency: "yearly",
    priority: 0.3,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/acceptable-use",
    changeFrequency: "yearly",
    priority: 0.3,
    a11y: true,
    sitemap: true,
  },
  {
    path: "/sub-processors",
    changeFrequency: "yearly",
    priority: 0.3,
    a11y: true,
    sitemap: true,
  },
];

/** Routes advertised in the sitemap, in manifest order. */
export function sitemapRoutes(): readonly MarketingRoute[] {
  return MARKETING_ROUTES.filter((r) => r.sitemap);
}

/** Paths the real-browser accessibility gate must scan. */
export function a11yRoutes(): readonly string[] {
  return MARKETING_ROUTES.filter((r) => r.a11y).map((r) => r.path);
}
