// The billing feature flag (S4.4). Everything Stripe-facing gates on BILLING_MODE so the whole subsystem
// ships DARK and going live is a single config flip, never a code change. Three modes:
//   off  — no Stripe calls at all (the default + the fail-safe for any unset/garbage value).
//   test — Stripe TEST-mode keys: Checkout/Portal/meter-reports run against Stripe's sandbox. Safe to
//          exercise end-to-end (test clocks) without touching real money.
//   live — Stripe LIVE keys + real charges. This is the FOUNDER-GATED activation flip (with the live
//          secret bindings + published prices); code never selects it on its own.
// Pure + deterministic so every surface (api/engine/web) agrees on the mode from the same injected value.

export type BillingMode = "off" | "test" | "live";

const BILLING_MODES = ["off", "test", "live"] as const;

/**
 * Parse the injected BILLING_MODE deploy var. FAIL-SAFE: anything not exactly one of the three known modes
 * (unset, blank, typo, wrong case handled by lowercasing) → "off", so a misconfig can never accidentally
 * enable Stripe — least-astonishment for a money subsystem.
 */
export function parseBillingMode(raw: string | undefined | null): BillingMode {
  if (raw == null) return "off";
  const v = raw.trim().toLowerCase();
  return (BILLING_MODES as readonly string[]).includes(v) ? (v as BillingMode) : "off";
}

/** Whether ANY Stripe integration is active (test or live). `off` → everything Stripe is a no-op. */
export function billingEnabled(mode: BillingMode): boolean {
  return mode !== "off";
}

/** Whether we are charging REAL money (live keys). The one place that gates real-charge behavior. */
export function billingLive(mode: BillingMode): boolean {
  return mode === "live";
}

/**
 * The Stripe subscription statuses that ENTITLE an org to its paid plan — an ALLOWLIST, so a status Stripe
 * adds later is fail-closed (not entitled) rather than silently granting a paid plan. `past_due` is included
 * deliberately: dunning is a grace window, and ADR-0020 forbids instant-pausing a customer whose card just
 * failed. `unpaid` is Stripe's END of dunning (retries exhausted), `incomplete*` never completed a first
 * payment, and `paused` is a suspended trial — none are entitled.
 *
 * A non-entitled subscription is treated as FREE: `effectiveBillingPeriod` puts the org back on the one-time
 * lifetime allowance, and the state-sync drops the mirrored paid cap. Without this, any non-`canceled` status
 * (Stripe only writes `canceled` on an explicit `subscription.deleted`) would keep a monthly-resetting paid
 * cap forever — an unpaid customer, or one who merely opened Checkout, on a free paid plan.
 */
export const BILLING_ACTIVE_STATUSES = ["active", "trialing", "past_due"] as const;

/** Whether a raw Stripe subscription status entitles the org to its paid plan. Exact match, no coercion. */
export function isBillingActive(status: string): boolean {
  return (BILLING_ACTIVE_STATUSES as readonly string[]).includes(status);
}
