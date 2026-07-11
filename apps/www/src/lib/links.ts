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
  changelog: `${DOCS}/changelog`,
  security: `${DOCS}/concepts/security`,

  /** The Product menu has no marketing feature pages behind it, so it points at the concepts docs. */
  concepts: {
    captureAndReplay: `${DOCS}/concepts/how-webhook-co-works`,
    ingestion: `${DOCS}/concepts/ingest-urls`,
    delivery: `${DOCS}/concepts/delivery-retry-signing`,
    verification: `${DOCS}/guides/verify-inbound-signatures`,
    mcpServer: `${DOCS}/mcp/overview`,
    security: `${DOCS}/concepts/security`,
  },

  // ── site ─────────────────────────────────────────────────────────────────
  home: "/",
  pricing: "/pricing",

  // ── external ─────────────────────────────────────────────────────────────
  openSource: REPO,
  standardWebhooks: "https://www.standardwebhooks.com/",
  contact: "mailto:sourabh@webhook.co",
} as const;

/** Enterprise is contact-sales, and it routes to a different inbox than the general contact link. */
export const SALES = "mailto:sales@webhook.co";
