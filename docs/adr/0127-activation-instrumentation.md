# ADR-0127: activation instrumentation — a privacy-safe "weekly activated developers" number

- **Status:** Accepted
- **Date:** 2026-07-20
- **Relates to:** ADR-0125 (the telemetry data-safety boundary — no PII/secrets in spans, logs, or metric
  labels), ADR-0124 (the observability spine), ADR-0122 (the org-wide events route), the metering rollup
  (`packages/db/src/usage-rollup.ts`) and delivery-stats rollup (`packages/db/src/delivery-stats-rollup.ts`)
  this deliberately mirrors, AGENTS.md compliance-by-design (tenant isolation via RLS, PII scrubbing,
  single-dimension metering) and transparent-pricing constraints.

## Context

We could not answer the one question a developer-tools company most needs to answer: **how many developers,
this week, actually got value?** "Value" here is concrete — the wedge is a free signed URL that captures a
webhook and replays it to localhost — so an *activated* developer is one who **captured a real event AND
replayed it to their machine**. That number needs to be real, queryable, and trended over months, without
leaking PII, without inflating a billable counter, and without adding a failure mode to the ingest or replay
hot path.

Three facts shaped the design:

- **The hot path must not gain a counter.** The constitution forbids hidden per-step counters (metering is
  single-dimension), and ingest/replay are latency-critical. So activation is **derived**, never emitted.
- **The source rows are ephemeral.** Per-plan retention (ADR/metering) purges `events` and
  `delivery_attempts` well before a multi-month trend could be reconstructed from them. A durable snapshot is
  required — but it must be derivable from what the product already writes.
- **Cross-tenant aggregates are private-by-default.** A "how many developers activated" number spans every
  org. Reading across tenants is normally forbidden by row-level security; doing it safely — without a
  bypass, without exposing per-org data, and without ever reaching the request path — is the crux.

## Decision

### The north-star, and the funnel under it

**Weekly activated developers** = distinct orgs that both **captured** and **forwarded** within an ISO week.
Under it sits the one-time acquisition funnel: **signup → first capture → first forward**, with
time-to-first-value (TTFV) as the median/p90 hours from signup to first forward.

`status='forwarded'` on `delivery_attempts` is **uniquely** the localhost-tunnel writer (the CLI POSTs to
localhost and only records that row on a local 2xx); automated server deliveries use
`queued`/`pending`→`delivered`/`failed`. So "forwarded to localhost" — the activation act — is exactly a
`status='forwarded'` row, with no new emit point.

### Derive off the hot path

Both milestones are a `MIN` over rows the product already writes:

- **first capture** = `MIN(events.received_at)`
- **first forward** = `MIN(delivery_attempts.created_at WHERE status='forwarded')`

There is no activation counter anywhere on ingest or replay. Migration 0092 adds the substrate:

- `activation_org_milestones` (per-org, set-once): `signed_up_at`, `first_capture_at`, `first_forward_at`,
  and the cookieless first-touch (`first_touch_source/medium/campaign`). Set-once/monotonic-earliest, so it
  survives source pruning.
- `activation_org_weekly` (per-org, per-ISO-week): `captured`/`forwarded` flags, **OR-accumulated**, so a
  week's activity, once recorded, survives retention.
- `activation_org_exclusions` (ops-only): internal/test/founder orgs kept out of every metric. Secured
  purely by **ownership** (no RLS, no `webhook_app` grant) like `processed_stripe_events`, so a tenant can't
  even self-exclude to game the number.

### The rollup, mirroring what already exists

Two `SECURITY INVOKER` functions run per-tenant under `webhook_app` RLS (mirroring `rollup_delivery_stats`):
`rollup_activation_milestones()` fills/lowers the milestones via `LEAST` (idempotent; a late scan can never
regress a milestone), and `rollup_activation_weekly(week)` OR-accumulates the weekly flags. A driver
(`runActivationRollup`) enumerates active orgs **cross-org as the least-privilege `webhook_meter` role**
(events ∪ forwards since the settle window — the delivery arm catches a *replay of an older event*, which the
events arm would miss), then re-rolls each org under its own RLS context. It runs on the engine's existing
**hourly cron**, reusing the metering Hyperdrive bindings — no new binding, no new role, no new Analytics
Engine metric. Per-org failures are isolated; the pass is bounded + fairly ordered.

### Cross-org read, confined — not bypassed

The founder's weekly review reads across every org. Rather than a bypass, `activation_weekly_review()` is a
single `SECURITY DEFINER` function confined the same way as `user_org_directory` (0067): the three activation
tables carry `for select to webhook_owner using(true)` policies, and because the tables `FORCE ROW LEVEL
SECURITY`, the definer (`webhook_owner`) is **policed by those policies, not exempt from them**. The function
returns **aggregates only** — one row per ISO week, never an `org_id`, never PII: the one-time funnel
(signups / first_captures / first_forwards + TTFV, a cohort keyed by signup week so `activation_rate =
first_forwards / signups` is a real conversion bounded [0,1]) and the weekly-recurrence NSM
(`activated_orgs`). Its `EXECUTE` is **revoked from `PUBLIC` and never granted to `webhook_app`** — the
request-path role is denied outright (a test pins this), because platform-wide aggregates are
private-by-default and must never reach a tenant.

### Read path

The metric is queryable today over an **owner** connection: `select * from activation_weekly_review();`. A
typed reader (`readActivationWeeklyReview`) maps the aggregate rows for any caller. A **founder-gated HTTP
endpoint** is deliberately deferred: it needs a dedicated read-only reviewer DB role + Hyperdrive binding
(the first HTTP surface for platform-wide aggregates), which a background session can't provision — so it is
a founder-run follow-up, not shipped dark. See "Deferred" below.

### First-touch acquisition attribution

> **Amended 2026-07-20 — superseded in part by [ADR-0128](0128-first-touch-consent-cookie.md).** The
> "cookieless" URL-param mechanism described in this section was replaced during implementation by a
> **consent-gated first-party `.webhook.co` cookie** (`wh_first_touch`), set by the marketing site only
> after the visitor accepts a cookie banner and read by the auth signup hook. The milestone/rollup design
> above is unchanged; only *how the utm reaches signup* changed — and the cookie also gives OAuth signups
> attribution, which the URL-param approach could not. See ADR-0128 for the rationale and the ePrivacy
> consent decision.

At signup we stamp `signed_up_at` + a normalized first-touch onto the org's milestone row, **first-touch
wins**. The mechanism is cookieless: the marketing CTA appends `?utm_*` to the auth `/login` URL; the login
page folds them into the Better Auth `callbackURL`; on the magic-link **verify** request (where the user is
created) they ride that `callbackURL`, and the `user.create.after` hook reads them off the endpoint context Better
Auth already hands the hook (no `AsyncLocalStorage`). **OAuth signup is best-effort null** — the provider
callback carries only an opaque `state`, and recovering the original utm would mean importing fragile
library internals; `signed_up_at` is still stamped, so an OAuth signup counts in the funnel with a null
source. utm values are normalized through a strict **allowlist** (`^[a-z0-9._-]+$`, ≥1 alphanumeric, ≤64
chars, lowercased); anything else is dropped to null. There is no PII here — utm are campaign slugs, never a
person — and the durable value is bounded and log-safe by construction (ADR-0125).

`signed_up_at` is written for **every** signup (not just those with a utm), so the funnel's signups
denominator no longer depends on the rollup, which only ever sees orgs that became active.

## Consequences

- **Shipped (PRs 1–4):** the durable substrate + rollup fns + review fn (migration 0092); the rollup driver
  on the hourly cron; the typed weekly-review reader; and the signup first-touch capture. The metric is real
  and queryable today; no hot-path change; no new AE metric; no PII anywhere; cross-org reads confined to one
  owner-only, aggregate-only function.
- **Deferred (founder-run):**
  1. A **founder-gated read surface** (endpoint/dashboard) — needs a dedicated `webhook_activation_reviewer`
     role + Hyperdrive binding, provisioned like `webhook_reaper` (a background session is prod-DB blocked).
     Until then the review runs as owner SQL.
  2. The **www → auth handoff** that turns first-touch on (below). Until it ships, `signed_up_at` is captured
     for every signup but `first_touch_*` stays null.
- **Cross-lane handoff (human-UI verification required):** to activate first-touch,
  (a) the marketing CTA links to `auth.webhook.co/login?utm_source=…&utm_medium=…&utm_campaign=…` (slug
  values — spaces are dropped by the allowlist, so use `spring-sale`, not `spring sale`);
  (b) the auth `/login` page/actions read those utm from `window.location.search` and append them to the
  `callbackURL` handed to `signIn.magicLink`/`signIn.social`; and
  (c) the privacy policy notes that acquisition source (utm) is recorded at signup, contains no personal
  data, and is used only for aggregate funnel measurement. These are user-facing and must be eyeballed by a
  human before they are considered done.
- **Watch-outs:** first-touch distinct-value cardinality is attacker-influenceable (bounded per row, but N
  signups → N distinct slugs); harmless while `first_touch_*` is unindexed and never grouped, but bound the
  distinct set (a known-source lookup) before any dashboard groups by it. The weekly-review function is
  owner-only by design; a future parameterized/paginated read would extend the reader, not the request-path
  role.
