# Knowledge base for docs.webhook.co — design spec

Date: 2026-07-18 · Status: approved-to-build (founder pre-authorized Option A; redirect open)
Lane owner: knowledge-base

## Problem

`docs.webhook.co` (Mintlify, `apps/docs`, 65 MDX pages) is entirely **developer-facing**
(Documentation / Guides / API reference / CLI & SDKs / MCP & agents / Changelog). There is no
customer/end-user knowledge base: no findable, task-based content for account, billing,
organizations, roles, usage/limits, security/privacy, or a consolidated troubleshooting hub for
non-developers and non-technical stakeholders (finance, security/procurement, ops).

## Goal

Add a comprehensive-but-lean **Help** knowledge base as a new top-level tab inside the existing
Mintlify site — covering every category the product actually supports today, weighted toward
troubleshooting + security/trust + honest billing, **linking to (never duplicating)** the dev docs,
and **never publishing a claim the product can't back**.

## Research basis (three Opus agents, 2026-07-18)

Raw findings in the job scratch dir:
- `research-saas-kb-ia.md` — 17 help centers + NN/g IA → 8-bucket intent-led MVP.
- `research-webhook-competitors.md` — 20+ webhook vendors → dev-first vendors fold KB into docs;
  the flagship opening is a sharp troubleshooting hub; keep account cluster lean.
- `research-product-groundtruth.md` — source audit → the binding **writability matrix** (below).

Both IA agents converged on: integrate (don't shadow dev docs), weight to troubleshooting +
security + honest billing, cut bloat formats (video/forum/persona pages/per-provider farms), and
don't fabricate. Devil's-advocate adjustment we adopted: **do NOT keep the account/billing/security
cluster minimal** — the product's goal is to serve non-developers, and a pre-traffic product must
**pre-write predictable questions** rather than wait for ticket volume to pull them into existence.

## Locked decisions (founder)

1. **Placement** — new **Help** tab in `apps/docs` (one site, one search, Mintlify GitHub-App deploy).
2. **Gap policy — document reality only.** An article ships only if the product does the thing today
   (verified against source). No aspirational "coming soon" pages; no "email support" stopgaps.
   Missing-feature topics → internal product-gap backlog, not published.
3. **Cadence** — phased waves; each = branch → TDD (red→green) → `pnpm lint`+guards → `/code-review`
   → `/security-review` → admin squash-merge → deploy. Continuous.
4. **Scope** — Option A (comprehensive-but-lean). B (strictly-minimal) / C (maximal) offered; A chosen.

## Information architecture — the Help tab (8 intent-led buckets)

Only WRITABLE-NOW articles are listed; excluded topics are in the product-gap backlog.

1. **Getting started** — what webhook.co is (non-dev framing) · create an account (OAuth + magic
   link) · first sign-in & onboarding · a tour of the dashboard · glossary (endpoint, event, ingest
   URL, destination, delivery — plain-English, links to `/concepts/*`).
2. **Your account** — how you sign in (OAuth + magic link; *there is no password* — stated plainly) ·
   sessions & signing out everywhere · change your name & avatar · change your email (code-verified) ·
   delete your account (GDPR erasure; the sole-owner-of-a-shared-org caveat) · connected apps.
3. **Organizations & members** — organizations vs teams (terminology) · create an organization ·
   invite & manage members · roles & permissions (owner/admin/member — a capability table) · rename
   an organization / change its URL slug · delete an organization.
4. **Billing & plans** *(gated on `BILLING_MODE` live-check)* — plans & pricing (EUR ladder,
   single-sourced from `@webhook-co/shared/plans`) · how events are counted (→ Usage) · upgrade or
   downgrade · manage payment method & invoices (Stripe Customer Portal) · cancel your subscription
   (end-of-period) · our refund policy (published policy: no automatic refunds) · what happens at
   your cap.
5. **Usage & limits** — what counts as an event (and what never does) · your free allowance
   (5,000 events, once) · usage alerts (80% / 100%) · what happens when you reach your cap (pause,
   429, events dropped) · data retention windows.
6. **Security & privacy** — how we protect your data (encryption in transit/at rest, KMS-sealed
   secrets, tenant isolation via RLS) · where your data lives (EU region pinning; the ingress
   residual, stated honestly) · the tamper-evident audit log and how to verify it · our compliance
   posture (GDPR Art. 28 DPA + SCCs; **no SOC 2 / ISO 27001 / HIPAA / PCI** — stated plainly) · how
   we handle your payload data (bodies/headers stored **unredacted** by design — inspection is the
   product) · report a security vulnerability.
7. **Troubleshooting & FAQ** *(flagship)* — my webhooks aren't arriving · a delivery failed
   (HTTP status → cause → fix table) · signature verification fails (raw-body table) · retries &
   the retry schedule · duplicate deliveries / idempotency · ordering is not guaranteed · a delivery
   is `blocked` (SSRF) · my endpoint returns 429 (paused) · 401 / 403 auth errors · a leaked API key.
   Consolidates and links the existing dev troubleshooting rather than duplicating it.
8. **Getting help** — contact support and what to include (`x-request-id`) · reliability behavior
   (retries, dead-letter, delivery guarantees — **no uptime/SLA claim**) · changelog · policy links
   (Terms · Privacy · DPA · AUP · sub-processors).

## Excluded — product-gap backlog (NOT published; founder decides per item)

2FA/MFA/passkeys · SSO/SAML (disabled "coming soon") · email/password auth · **refund flow** · in-app
**ownership-transfer** UI (blocks self-deletion of a sole owner of a shared org — a real dead-end) ·
per-plan endpoint/destination/seat limits · **formal certifications** (SOC 2/ISO/HIPAA/PCI) ·
rich/configurable **delivery-failure alerting** · welcome email. Two items flagged for founder
attention because "no article at all" can itself read as a gap: (a) account/data-deletion is
WRITABLE and will be published; (b) ownership-transfer is a genuine product dead-end worth fixing.

## Architecture

- Content: `apps/docs/help/<bucket>/<article>.mdx`; a bucket landing page per section.
- New `Help` tab in `apps/docs/docs.json` with 8 groups + icons.
- Components: reuse the house set — `<AccordionGroup>`/`<Accordion>`, `<CardGroup>`/`<Card>`,
  `<Steps>`/`<Step>`, `<Note>`/`<Warning>`, `<Tabs>`. Frontmatter: `title`, `sidebarTitle`,
  `description`, `icon`.
- Voice: repo brand voice (AGENTS.md) — precise, quietly opinionated, developer-to-developer;
  sentence-case headings; lowercase `webhook.co` / `wbhk.my`. Article shape: one-line TL;DR →
  prerequisites → numbered steps → related links → "still stuck?" escalation (mirrors
  `troubleshooting.mdx`).
- Cross-linking: root-relative (`/help/...`, `/guides/...`, `/concepts/...`, `/reference/...`).
  KB articles LINK to dev docs for anything technical; they do not restate signing/retry internals.

## Testing & guards — the TDD backbone for a docs surface

`apps/docs` has **no CI protection** today (no `package.json`; Mintlify builds it externally; only a
local `npx mint broken-links`). Two tested, parse-based guards close that gap. Both: parse (never
text-scan), carry a zero-input FLOOR, co-locate a `.test.mjs` run by `test:scripts`, and wire into
`pnpm lint` (a required check). Lessons applied: `guard-scripts-must-parse-not-scan`,
`a-guards-tests-must-run-the-guard`, `derived-artifact-guard-trigger`.

### Guard A — extend `scripts/no-unverified-claims.mjs` to cover `apps/docs` MDX
Add `apps/docs` to the scanned trees; teach the walker `.mdx`; add an MDX-aware stripper (blank out
`{/* */}` expression comments, `<!-- -->` HTML comments, fenced ```` ``` ```` code blocks, and
indented code) before running the existing `CLAIM_RULES`. Keep the per-tree "scanned 0 files" floor.
Effect: the KB can never publish an unbacked SLA/uptime/latency/volume/cert/BAA/SSO/guarantee/
audit-export claim. **TDD:** red tests first — an MDX fixture where prose + `<Stat>`-style claims are
caught, fenced-code/comment claims are ignored, and a plan-quota ("includes … up to") passes.

### Guard B — new `scripts/docs-nav-guard.mjs`
Parses `apps/docs/docs.json` (JSONC-safe) + the MDX tree; fails on: a nav page reference with no
`.mdx` (dangling nav) · an `.mdx` not reachable from nav and not allow-listed (orphan) · missing
required frontmatter (`title`, `description`) · a root-relative internal link that resolves to no
page (broken internal link; deterministic, no network). Zero-input floor: fail if 0 pages parsed.
**TDD:** red tests first, one per rule + the floor.

## Wave plan

- **Wave 1 — foundation:** this spec + product-gap backlog; Guard A extension (TDD); Guard B new
  (TDD); `Help` tab scaffold in `docs.json` with the 8 bucket landing pages; both guards green in
  `pnpm lint`. Ships the safety net first. Human-eyeball flag: rendered Help tab.
- **Wave 2 — Getting started + Your account.**
- **Wave 3 — Organizations & members.**
- **Wave 4 — Billing & plans + Usage & limits.** First step: verify `BILLING_MODE` live via
  `gh variable list`. If unconfirmable/off, publish Usage & limits + plans/pricing (always true) and
  hold the self-serve-billing "available today" articles.
- **Wave 5 — Security & privacy.**
- **Wave 6 — Troubleshooting & FAQ (flagship).**
- **Wave 7 — Getting help + reliability + glossary + cross-link/redirect polish; fix known staleness
  (`leaked-api-key.mdx` legacy `/settings/credentials` link).**

## Per-wave definition of done

Red→green tests · `pnpm lint` (guards) green · `pnpm test` / `test:scripts` green · `/code-review`
clean · `/security-review` clean · rebased on `origin/main` · admin squash-merge · Mintlify deploy ·
lane memory + internal product-gap backlog updated. Human-UI eyeball items (rendered layout, brand,
nav) explicitly flagged for the founder — never self-approved (AGENTS.md human-UI hard stop).

## Non-goals

A `help.` subdomain · a ticketing system / owned forum · video/courses · persona landing pages ·
per-provider article farms · any published uptime/SLA · restating dev-doc internals in the KB.
