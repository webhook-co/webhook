/**
 * Every destination the marketing site links to, in one place.
 *
 * These were inlined `href="#"` across nine components — the footer's own comment called them
 * "placeholders … owned by the L3 wiring lane". This is that lane. Centralising them means a docs
 * reorg is one edit, not a scavenger hunt, and it makes the *gaps* legible: a link that points at
 * {@link PLACEHOLDER} is a surface that genuinely does not exist yet, not one someone forgot.
 *
 * `links.spec.ts` actually REQUESTS every external href and asserts a 200 — because a link to a
 * renamed docs slug is a 404, and a unit test comparing strings against the same constants it is
 * testing cannot tell the difference. That check is the only thing standing between a docs reorg and
 * a footer full of 404s.
 */

export const APP = "https://app.webhook.co";
export const AUTH = "https://auth.webhook.co";
export const DOCS = "https://docs.webhook.co";
export const GITHUB = "https://github.com/webhook-co";
export const REPO = `${GITHUB}/webhook`;

/**
 * The surfaces that do not exist yet: About, Blog, X, LinkedIn, a status page, a public roadmap.
 * Deliberately left inert rather than pointed somewhere approximate — a link whose label lies
 * ("See the roadmap" → the docs) is worse than one that doesn't go anywhere.
 */
export const PLACEHOLDER = "#";

export const LINKS = {
  // ── product ──────────────────────────────────────────────────────────────
  /** Sign-in. Matches what apps/web redirects to (`apps/web/src/server/session.ts`). */
  signIn: `${AUTH}/login`,
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
