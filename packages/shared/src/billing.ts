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

/**
 * The TERMINAL Stripe subscription statuses — the subscription object no longer exists at Stripe, so a
 * fresh Checkout is the correct (and only) way to resubscribe and CANNOT create a duplicate. `canceled` is
 * an explicit `subscription.deleted`; `incomplete_expired` is a first payment that never completed and was
 * garbage-collected. Every OTHER status (active/trialing/past_due/unpaid/paused/incomplete) is a subscription
 * that still LIVES — starting a new Checkout on the same customer would double-subscribe them.
 */
const TERMINAL_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired"] as const;

/**
 * Whether a subscription with this status still exists at Stripe (so a NEW Checkout on the same customer
 * would create a duplicate). Fail-SAFE: an unknown/blank status counts as live, so we block a possible
 * double-subscribe rather than risk one. This is the money guard behind both the upgrade-picker gating and
 * the `startCheckout` already-subscribed backstop.
 */
export function isLiveSubscriptionStatus(status: string): boolean {
  return !(TERMINAL_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * The plans a user can buy from the dashboard without talking to us. Enterprise is deliberately absent —
 * it is a contact-sales motion, never a hosted Checkout — and so is `free`, which has no price at all.
 *
 * `scale`, not `team`: every tier names an INTENSITY, and we do not meter seats. A three-person startup
 * pushing 10M events belongs on the top self-serve tier, and a tier called "Team" would argue otherwise.
 */
export const SELF_SERVE_PLAN_IDS = ["pro", "scale"] as const;
export type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];

/** Display names for the self-serve tiers — co-located with the ids so adding a plan is a single edit
 *  (a new id without a label here is a type error, not a silent raw-slug fallback in the dashboard). */
export const SELF_SERVE_PLAN_LABELS: Record<SelfServePlanId, string> = {
  pro: "Pro",
  scale: "Scale",
};

/** Human label for a plan id (or an unknown/legacy tier). Falls back to a generic name, never a raw slug. */
export function planLabel(id: string): string {
  return isSelfServePlan(id) ? SELF_SERVE_PLAN_LABELS[id] : "Paid plan";
}

/** Whether `id` names a plan that Checkout may sell. Anything else must not reach a Stripe line item. */
export function isSelfServePlan(id: string): id is SelfServePlanId {
  return (SELF_SERVE_PLAN_IDS as readonly string[]).includes(id);
}

/** One plan's Stripe PRICE IDS — the licensed base + the metered overage. Ids only: never an amount. */
export interface StripePlanPrices {
  readonly base: string;
  readonly overage: string;
}
export type StripePlans = Partial<Record<SelfServePlanId, StripePlanPrices>>;

/** A plan entry carries exactly these keys — anything else (notably an `amount`) is a misconfiguration. */
const PLAN_PRICE_KEYS = ["base", "overage"] as const;

/**
 * Parse the `STRIPE_PLANS` deploy var: a JSON map of self-serve plan id → `{ base, overage }` price ids.
 * Prices live in Stripe; only IDS cross into this repo, so no price/tier figure is ever committed.
 *
 * FAIL-CLOSED in every direction — a malformed, half-configured, non-self-serve, or amount-carrying config
 * returns null and the dashboard simply shows no Checkout. A wrong Checkout charges a real customer the
 * wrong money; no Checkout merely blocks an upgrade. One bad plan rejects the WHOLE map, because a silently
 * dropped plan is a plan the user cannot buy while the page still claims to sell it.
 */
export function parseStripePlans(raw: string | undefined | null): StripePlans | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return null;

  const plans: Record<string, StripePlanPrices> = {};
  for (const [id, value] of entries) {
    if (!isSelfServePlan(id)) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== PLAN_PRICE_KEYS.length) return null; // an extra key (e.g. `amount`) → reject
    const { base, overage } = value as Record<string, unknown>;
    if (typeof base !== "string" || base.length === 0) return null;
    if (typeof overage !== "string" || overage.length === 0) return null;
    plans[id] = { base, overage };
  }
  return plans as StripePlans;
}

/** The org's current-plan display shape (derived, dashboard-facing). Pure so the Billing card is testable. */
export interface BillingSubscriptionSummary {
  /** The subscription's base (licensed) price id — the tier discriminator. */
  readonly plan: string;
  /** Raw Stripe status (verbatim). */
  readonly status: string;
  /** current_period_end as an ISO string — renewal date, or cancel date when canceling. */
  readonly currentPeriodEnd: string;
  readonly cancelAtPeriodEnd: boolean;
}

/** A dashboard-facing billing state. `trialing` = entitled but no charge yet (shown date is the FIRST
 *  charge, not a renewal); `canceling` = active-but-scheduled-to-cancel; `inactive` = a non-entitled status
 *  (unpaid/incomplete/paused) that has dropped to the Free allowance. */
export type BillingState =
  "active" | "trialing" | "past_due" | "canceling" | "canceled" | "inactive";

export interface BillingDisplay {
  /** The self-serve tier this subscription is on, or "unknown" if the base price isn't in STRIPE_PLANS
   *  (e.g. a legacy/archived price) — the card falls back to a generic "paid plan" label. */
  readonly tier: SelfServePlanId | "unknown";
  readonly state: BillingState;
  readonly periodEnd: string;
  readonly cancelAtPeriodEnd: boolean;
}

/** Reverse-lookup the self-serve tier whose BASE price equals `basePriceId`. Ids only, no Stripe call. */
export function planIdForBasePrice(
  plans: StripePlans,
  basePriceId: string,
): SelfServePlanId | null {
  for (const id of SELF_SERVE_PLAN_IDS) {
    if (plans[id]?.base === basePriceId) return id;
  }
  return null;
}

/**
 * Derive the dashboard billing state from a synced subscription. Order matters and encodes ADR-0020's grace
 * rule. Precedence, highest first:
 *   1. `canceled` — explicit `subscription.deleted`, terminal.
 *   2. non-entitled (unpaid/incomplete/paused) → `inactive` (dropped back to the Free allowance).
 *   3. `past_due` — a failing card is the actionable state and must surface even when the sub is ALSO
 *      scheduled to cancel (so it is checked BEFORE cancelAtPeriodEnd; hiding it behind "canceling" would
 *      bury the dunning message during the grace window).
 *   4. `cancelAtPeriodEnd` (and not past_due) → `canceling`.
 *   5. `trialing` → its own state (the shown date is the FIRST charge, not a renewal — "Renews" would lie).
 *   6. otherwise `active`.
 * Pure + exhaustively unit-testable.
 */
export function billingDisplayFromSubscription(
  sub: BillingSubscriptionSummary,
  plans: StripePlans,
): BillingDisplay {
  const tier: SelfServePlanId | "unknown" = planIdForBasePrice(plans, sub.plan) ?? "unknown";
  const base = {
    tier,
    periodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
  const state: BillingState =
    sub.status === "canceled"
      ? "canceled"
      : !isBillingActive(sub.status)
        ? "inactive"
        : sub.status === "past_due"
          ? "past_due"
          : sub.cancelAtPeriodEnd
            ? "canceling"
            : sub.status === "trialing"
              ? "trialing"
              : "active";
  return { ...base, state };
}

/**
 * Does this Stripe secret key belong to this billing mode? Founder rule (2026-07-09): **localhost and any
 * test-mode deploy use the SANDBOX account; only a `BILLING_MODE=live` prod deploy uses the LIVE account.**
 *
 * Enforced rather than trusted, because both mismatches are silent and expensive:
 *   - a live key under `BILLING_MODE=test` would charge REAL CARDS from a deploy nobody thinks is live;
 *   - a test key under `BILLING_MODE=live` would take NO money while the dashboard cheerfully sells plans.
 *
 * Fails CLOSED on anything unrecognised — a publishable key (`pk_`), a restricted key (`rk_`, whose scopes we
 * don't control), a signing secret, or an empty binding all return false and the caller declines to build a
 * client. Prefix match is exact and case-sensitive: Stripe's key prefixes are lowercase.
 */
export function stripeKeyMatchesMode(mode: BillingMode, secretKey: string): boolean {
  if (mode === "live") return secretKey.startsWith("sk_live_");
  if (mode === "test") return secretKey.startsWith("sk_test_");
  return false; // billing off: no key is legitimate
}
