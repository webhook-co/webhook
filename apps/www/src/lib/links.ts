/**
 * Every destination the marketing site links to, in one place.
 *
 * These were inlined `href="#"` across nine components — the footer's own comment called them
 * "placeholders … owned by the L3 wiring lane". This is that lane. Centralising them means a docs
 * reorg is one edit, not a scavenger hunt.
 *
 * There is deliberately NO placeholder constant. The site ships zero `href="#"` and
 * `scripts/check-no-dead-links.mjs` enforces it, so a surface that doesn't exist yet renders as TEXT
 * (see the footer) rather than as a link to nowhere. A `PLACEHOLDER = "#"` export would just be a
 * loaded gun pointed at that guard.
 *
 * `links.spec.ts` actually REQUESTS every external href and asserts a 200 — because a link to a
 * renamed docs slug is a 404, and a unit test comparing strings against the same constants it is
 * testing cannot tell the difference. That check is the only thing standing between a docs reorg and
 * a footer full of 404s.
 */

export const APP = "https://app.webhook.co";
export const DOCS = "https://docs.webhook.co";
export const GITHUB = "https://github.com/webhook-co";
export const REPO = `${GITHUB}/webhook`;

export const LINKS = {
  // ── product ──────────────────────────────────────────────────────────────
  // No `signIn`. The nav used to carry BOTH "Sign in" and "Start free", which landed the same visitor
  // in the same place — `app.webhook.co` bounces a signed-out user to the login screen, and that
  // screen says "No account yet? Signing in creates one." One door, one label.
  startFree: APP,
  /** Where the paid-tier CTAs land: the usage page, which is where a plan is chosen. */
  usage: `${APP}/usage`,

  // ── docs ─────────────────────────────────────────────────────────────────
  docs: DOCS,
  quickstart: `${DOCS}/quickstart`,
  apiReference: `${DOCS}/api-reference/introduction`,
  cli: `${DOCS}/cli/overview`,
  mcp: `${DOCS}/mcp/overview`,
  /** The existing docs guides estate. We rename "Blog" → "Guides" here rather than run a blog. */
  guides: `${DOCS}/guides`,
  changelog: `${DOCS}/changelog`,
  security: `${DOCS}/concepts/security`,

  /** The docs pages each /product/* page (and the homepage showcases) deep-link to for detail. */
  concepts: {
    captureAndReplay: `${DOCS}/concepts/how-webhook-co-works`,
    delivery: `${DOCS}/concepts/delivery-retry-signing`,
    verification: `${DOCS}/guides/verify-inbound-signatures`,
    security: `${DOCS}/concepts/security`,
  },

  // ── product pages (www) ────────────────────────────────────────────────────
  // Real marketing pages now exist for each capability, so the Product nav menu and footer point
  // here (www) — only "Docs" leaves for docs.webhook.co. These deep-link to the docs for detail.
  product: {
    captureReplay: "/product/capture-replay",
    verification: "/product/verification",
    delivery: "/product/delivery",
    mcp: "/product/mcp",
    security: "/product/security",
  },

  // ── site ─────────────────────────────────────────────────────────────────
  home: "/",
  pricing: "/pricing",
  about: "/about",
  /** The no-signup sandbox. NOINDEX (robots) — a link to it is fine; the page's noindex keeps it out. */
  play: "/play",

  // ── external ─────────────────────────────────────────────────────────────
  openSource: REPO,
  standardWebhooks: "https://www.standardwebhooks.com/",
  contact: "mailto:sourabh@webhook.co",
} as const;

/** Enterprise is contact-sales, and it routes to a different inbox than the general contact link. */
export const SALES = "mailto:sales@webhook.co";
