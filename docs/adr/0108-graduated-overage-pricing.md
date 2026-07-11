# ADR 0108 — the included volume is a graduated Stripe tier, not an app-side pause artifact

- status: accepted.
- date: 2026-07-10
- scope: Stripe pricing config (the metered overage prices) + `STRIPE_PLANS`. No code, no migration.
- relates: [0004](0004-hybrid-flat-alert-first-pricing.md)-equivalent internal pricing ADR (Pro €19/500k,
  Scale €99/3M, overage €25/M), and the metering lane (internal `s4-billing-metering-lane`).

## context

Each paid plan is a Stripe subscription with a **licensed base** price (Pro €19, Scale €99) plus a
**metered overage** price (€25/M) attached to the `webhook_events` Billing Meter. The plan's included volume
(500,000 / 3,000,000 events) was expressed **only** in `price.metadata.event_cap`, mirrored into
`org_limits.event_cap` for the app-side soft-cap.

The overage price was a **flat `per_unit`** price (`unit_amount_decimal = 0.0025` = €25/M) with **no tiers
and no Stripe free tier**, and the meter-reporter sends the **full** daily usage (no over-cap subtraction).
Consequence: Stripe billed **every** reported event at €25/M — a customer inside their included volume (e.g.
a Pro at 400k of their 500k) would be invoiced €19 + €10 instead of €19, and even a soft-cap-paused customer's
≤cap usage billed at full rate. The included volume was never actually free in Stripe. (Not yet live-exposed:
zero paying customers at the time of this change.)

## decision

Express the included volume as a **graduated Stripe tier on the overage price**, so Stripe — not an app-side
pause — enforces "included then overage":

- `billing_scheme = tiered`, `tiers_mode = graduated`, two tiers:
  - tier 1 `up_to = <event_cap>`, `unit_amount_decimal = 0` (the included volume, free)
  - tier 2 `up_to = inf`, `unit_amount_decimal = 0.0025` (€25/M on the excess)
- Same overage product + meter + `metadata.event_cap`; base prices unchanged. New graduated prices provisioned
  in sandbox + live, `STRIPE_PLANS` repointed (base ids unchanged, overage ids → graduated), the flat overage
  prices archived. Reporter unchanged — it keeps sending full daily usage; Stripe sums the period and applies
  the graduated tiers once at invoice.

**Verified on a sandbox test clock before going live:** a Pro sub with 600,000 usage was invoiced €19 base +
graduated metered lines `(500000, €0)` + `(100000, €2.50)` = **€21.50** (only the 100k excess billed); a
300,000-usage sub was invoiced **€19.00** (€0 overage). Graduated tiers apply to the period-aggregated
quantity, so daily meter reports don't double-count.

## consequences

- Billing is correct in both soft-cap modes: `pause_policy='pause'` (usage capped at included → €0 overage,
  tier 1) and `pause_policy='allow'` (usage exceeds → tier 2 bills the excess only). This makes an **overage
  opt-in toggle** (`pause_policy`) meaningful — without graduated pricing it would mischarge in both states.
- The included volume now lives in **two** places that must agree: the graduated tier boundary (Stripe, what
  bills) and `metadata.event_cap` → `org_limits.event_cap` (the app, what pauses). Provisioning must keep the
  tier `up_to` equal to `event_cap` per plan. A future price change updates both.
- No migration and no code change — the fix is entirely in Stripe price objects + the `STRIPE_PLANS` var.
