# Billing dashboard UX + overage-pricing correctness — design

## Context

Billing is live (EUR, Definition-B metering). The founder asked for five dashboard improvements: (1) a
dedicated **Billing** section, (2) show the **current plan** after upgrading, (3) an **overage opt-in
toggle**, (4) reflect **downgrade/cancel** in the UI, (5) **plan switching** (in-dashboard and/or via the
Stripe Customer Portal).

Research (3 Explore agents + a live Stripe read) found that (2), (4) are mostly **surfacing data that already
exists but is unread** (`billing_subscriptions.plan/status/current_period_end/cancel_at_period_end` are synced
and RLS-readable by `webhook_app`), and (3) reduces to flipping `org_limits.pause_policy` — **but** it
uncovered a **P0 money bug** that gates the overage work:

> **The metered overage price is a flat `per_unit` €25/M with NO tiers and no Stripe free tier** (verified
> live: `price_1TrjHkDtU44D2jjHT4tyejS8` / `...esg67ZRs`, `tiers_mode=None`). The included volume
> (500k/3M) lives only in `metadata.event_cap` (mirrored to `org_limits` for the app-side pause), and the
> reporter sends **full** daily usage (no over-cap subtraction). So Stripe bills **all** usage at €25/M — a
> Pro customer at 400k events (inside their included 500k) would be billed €19 + €10, and even a
> `pause`-capped customer's ≤cap usage bills full×€25/M. Every paying customer would be over-charged by
> their entire included allowance. Not yet live-exposed: **0 paying customers**.

**Founder decisions (2026-07-10):** (1) **fix the pricing P0 first** as its own focused change, then build
the dashboard lane; (2) **hybrid** management surface — in-dashboard for current-plan + plan-switch + overage
toggle; Stripe Portal (already provisioned) for cancel + payment-method + invoices; cancel/downgrade **state**
surfaced in-dashboard with the ADR-0004 disclosure.

## Working agreement (per founder)

- **TDD throughout** (test-first). Pure cores + ephemeral-Postgres/vitest before wiring. Harnesses:
  `apps/web/src/server/billing.test.ts` + `billing-panel.test.ts` (mock stripe client + `withTenantDb`),
  `packages/db/test/*.test.ts` (RLS role clients), `packages/shared/src/stripe-client.test.ts` (fake fetch).
- Before every commit: **`/code-review` then `/security-review`**, loop to clean.
- **Ship autonomously** in the `billing-dashboard` worktree: rebase on origin/main, admin-squash-merge on
  green deterministic gates (test/test-db/typecheck/lint/build/gitleaks; ai-review advisory), deploy,
  prod-verify. No "say continue" checkpoints. Serial-merge race is expected → rebase+force-push before merge.
- **Local Stripe changes** (graduated prices) provisioned in **sandbox + live** (standing infra auth); a live
  key never reaches localhost; `stripeKeyMatchesMode` guards.
- Internal docs/backlog + memory updated as we go; internal-repo commits pushed to main automatically.
- **Enterprise-grade / secure / reliable / no deferrals / no half-measures.** Devil's-advocate every call.

## Workstreams

### WS1 — Graduated overage pricing (the P0). Ship first, standalone.

The included volume must be a Stripe **graduated** tier, not an app-side pause artifact.

- Provision **new graduated EUR overage prices** in sandbox + live, one per plan, on the SAME overage
  products + meter as today: `billing_scheme: tiered`, `tiers_mode: graduated`, two tiers —
  `up_to: <event_cap>` at `unit_amount_decimal: 0`, then `up_to: inf` at `unit_amount_decimal: 0.0025`
  (€25/M). Pro cap 500000, Scale cap 3000000. Keep `metadata.event_cap` (the app still mirrors it for the
  cap/pause). Base prices (Pro €19 / Scale €99, licensed) unchanged. Idempotency-Keys `wh-eur-grad-*`.
- Repoint `STRIPE_PLANS` (prod GH var + memory) to the new overage price ids; **archive** the flat overage
  prices (both accounts). 0 subscriptions → no migration of live subs.
- **Verify empirically** (sandbox test clock, extend `~/.claude/jobs/.../tmp/stripe_probe*.py`): a sub whose
  metered usage crosses the included boundary is invoiced **€0 for the included portion + €25/M for the
  excess only** (graduated math), and a fully-within-cap sub is invoiced **€0** overage. This is the gate.
- Deploy is config-only (GH var) → dispatch `deploy-web` (apps/web consumes `STRIPE_PLANS`). No code, no
  migration. Confirm a fresh live Checkout still builds base+graduated-overage line items.
- **Docs:** ADR (public, docs/adr/010x) recording included-volume-as-graduated-tier; update pricing docs if
  any figure implies "billed from event 1" (it shouldn't).

### WS2 — Dedicated Billing section + current-plan card

- **Reader:** add `readBillingSummary(orgId)` to `packages/db/src/reads.ts` (webhook_app, RLS `org_id =
  current_org_id()`), selecting `plan, status, current_period_end, cancel_at_period_end` from
  `billing_subscriptions` (grant already exists, `0044:53-54`). Map the `plan` **price id → tier** via a
  reverse lookup over `STRIPE_PLANS` (pro/scale) — no new Stripe call.
- **Route + nav:** new `apps/web/src/app/(app)/billing/` section; add a `<AppNavItem href="/billing">`
  in the **Account** group of `apps/web/src/components/app-nav.tsx`. Move the billing UI out of `usage/page.tsx`
  (usage keeps the usage meter; billing owns subscription). Update `BILLING_RETURN_URL` → `/billing`.
- **Current-plan card:** shows tier name, status (Active / Past due (grace) / Canceling on <date> /
  Canceled), renewal or cancel date, included volume, and the €25/M overage line. Enterprise = contact-sales.
  A rowless/no-customer org shows the upgrade picker (today's behavior, relocated).
- **Panel states:** extend `resolveBillingPanel` (or a richer `loadBillingSummary`) beyond the 3-state
  boolean to carry the subscription summary; TDD in `billing-panel.test.ts`.

### WS3 — Overage opt-in toggle (`pause_policy`)

- **Setter:** a tenant-scoped writer of `org_limits.pause_policy` (`'allow'`=overage on, `'pause'`=off) +
  evict the org's ingest-token KV entry so the edge cap-check re-reads (mirror how endpoints.delete evicts).
  `webhook_app` needs UPDATE on `org_limits.pause_policy` — **verify/add the grant** (today only
  webhook_billing + the cap-producer write org_limits). Migration if the grant is missing (a column-scoped
  `grant update (pause_policy) on org_limits to webhook_app` + a tenant `FOR UPDATE` policy).
- **Server action** `setOverage(orgId, enabled)` (apps/web/src/server/billing.ts) + a UI **toggle** on the
  billing page, gated to paid orgs (an off/rowless org can't enable overage). Default **off** (`pause`) —
  matches today + is the safe default; ADR-0004 disclosure copy near the toggle ("with overage on, usage
  above your plan bills at €25/M; with it off, capture pauses at your limit").
- **Persistence:** `applySubscriptionUpsert` writes only `event_cap`, so the user's `pause_policy` survives
  subscription updates; on cancel the `org_limits` row is dropped (→ `pause` default) which is correct.
- TDD: pure `shouldPauseForCap` already tested; add setter (ephemeral-pg, RLS: an org can only set its own)
  + action tests + the KV-eviction path.

### WS4 — Plan switching (Pro↔Scale), in-dashboard

- **Stripe client:** add `retrieveSubscription(id)` + `updateSubscription({id, items, prorationBehavior})`
  to `packages/shared/src/stripe-client.ts` via the existing generic `request()`/`get()` (no SDK). Switch =
  `GET /v1/subscriptions/{sub_id}` to read the base item's `si_...`, then `POST /v1/subscriptions/{sub_id}`
  swapping the base item's `price` to the new tier's base **and** the overage item's `price` to the new
  tier's graduated overage, `proration_behavior: create_prorations`.
- **Action** `switchPlan(orgId, targetPlanId)` reads the stored `stripe_subscription_id` (mirror exists),
  guards target ∈ self-serve + ≠ current, calls updateSubscription. The inbound `customer.subscription.updated`
  webhook already re-mirrors `event_cap`/`plan` (increase-now/decrease-defer), so the card reflects it.
- **UI:** switch buttons on the current-plan card (upgrade/downgrade within self-serve). TDD mirrors
  `billing.test.ts` (fake client records the update args) + `stripe-client.test.ts` (URL/param shaping).
- **Security:** org resolved from the session (not client input) → withTenant; the sub id read under RLS;
  never trust a client-passed subscription/customer id.

### WS5 — Cancel / downgrade surfacing + Portal for the rest

- **State surfacing (read-only):** the current-plan card renders `cancel_at_period_end` ("Cancels on
  <current_period_end>") and `status='canceled'`/non-entitled ("Canceled — on the free allowance") from the
  WS2 reader. On cancel/downgrade the inbound webhook already drops the `org_limits` paid cap → Free (paused
  once allowance spent) — surface that honestly with the ADR-0004 disclosure.
- **Portal (unchanged actions):** keep `openBillingPortal` for **cancel + payment-method + invoice history**
  (already provisioned: `subscription_cancel`, `payment_method_update`, `invoice_history`). A "Manage payment
  & invoices" / "Cancel plan" button opens the hosted portal. Do **NOT** enable portal `subscription_update`
  (plan switch is in-dashboard per the hybrid decision) — avoids two divergent switch paths.
- ADR-0004 mandates the "cancel loses your one-time allowance" disclosure at the cancel entry point.

## Sequencing

WS1 (pricing P0, standalone, ship + verify first) → WS2 (section + current-plan read) → WS3 (overage toggle)
→ WS4 (switch) → WS5 (cancel/downgrade surfacing). WS2–WS5 are one dashboard lane; each its own PR, TDD,
`/code-review` + `/security-review`, admin-merge on green, deploy-web, prod-verify.

## Verification

- **WS1:** sandbox test-clock invoice bills only the over-cap excess (graduated), within-cap bills €0
  overage; live Checkout builds correct line items; STRIPE_PLANS repointed + flat prices archived.
- **Dashboard:** local run (webhook worktree + sandbox `stripe listen` + dev-session) — subscribe → current
  plan shows Pro/Active/renewal; toggle overage → `org_limits.pause_policy` flips + KV evicts; switch Pro→Scale
  → prorated + card updates on the webhook sync; cancel via Portal → card shows "Cancels on <date>" then
  "Canceled". Unit/ephemeral-pg tests for every reader/action/panel state.
- **Security:** every action org-scoped from the session under RLS; no client-supplied sub/customer id
  trusted; overage setter can't cross tenants; Portal session bound to the org's own customer.

## Devil's advocate

- *"Overage toggle is just a pause flip — trivial."* Only AFTER WS1: without graduated pricing the toggle
  mischarges in both states. WS1 is the real work; the toggle is thin on top.
- *"Use the Portal for plan switch too — less code."* Rejected per hybrid: the Portal can't express the
  overage toggle and splits switch across two UIs; in-dashboard switch keeps one branded, controllable path.
- *"Graduated tiers could double-charge with the daily meter reports."* No — graduated tiers apply to the
  period-aggregated quantity; Stripe sums daily reports then applies tiers once at invoice. Verified by the
  WS1 test-clock gate before trusting it.
- *"cancel_at_period_end is enough; skip status nuance."* No — ADR-0020 forbids instant-pausing `past_due`
  (grace); the card must distinguish Active / Past-due-grace / Canceling / Canceled to not misinform.
