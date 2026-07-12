// The plan catalog — the ONE place a plan's public shape lives (name, price, included volume, retention,
// overage). A dependency-free leaf (zero imports, like retention.ts), so a lean consumer — the marketing
// pricing page, the dashboard billing cards — imports `@webhook-co/shared/plans` without dragging in the
// stripe-client / KMS / aws4fetch that the package root barrel pulls in.
//
// WHY this exists: the same numbers were duplicated across four places — apps/www's pricing-tiers.ts, this
// package's retention.ts (PLAN_RETENTION_DAYS), billing.ts (the self-serve ids/labels), and Stripe's price
// metadata — kept in step only by "change one, change both" comments. This catalog is now canonical, and
// retention.ts + billing.ts DERIVE their plan facts from it, so there is one number to change. A drift test
// pins that the marketing copy still agrees, and an ops script (no live Stripe key in CI) checks Stripe.
//
// These figures are PUBLIC and are what Stripe actually charges (the live prices carry the same amounts and
// `metadata.event_cap`). Change a number here → change the matching Stripe price too, or a surface lies.

/** The plan tiers, in ascending order — the order is the upgrade ladder (used to rank a downgrade). */
export const PLAN_IDS = ["free", "pro", "scale", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  readonly id: PlanId;
  /** Display name. */
  readonly name: string;
  /** A qualifier rendered before the amount ("From"), so it never wraps away from it. */
  readonly pricePrefix?: string;
  /** Display price, e.g. "€19". `null` = free. */
  readonly price: string | null;
  /** e.g. "/month". `null` for free. */
  readonly cadence: string | null;
  /** The human "included volume" line, e.g. "500,000 events / month". */
  readonly includedEvents: string;
  /**
   * The numeric included-event allowance — what Stripe carries as `metadata.event_cap`. `null` for
   * enterprise (committed/custom, not a self-serve number). The display string above must agree with this.
   */
  readonly eventCap: number | null;
  /** The one line saying who the tier is for. */
  readonly summary: string;
  /** The human retention line, e.g. "30-day retention". Must agree with `retentionDays`. */
  readonly retention: string;
  /** Retention window in days; `null` = unlimited (enterprise, never auto-pruned). */
  readonly retentionDays: number | null;
  /** Overage line, or the reason there isn't one. */
  readonly overage: string;
  /** The highlighted tier on the pricing grid. */
  readonly featured?: boolean;
  /** Whether Checkout may sell this tier self-serve (pro/scale). Free is implicit; enterprise is sales-led. */
  readonly selfServe: boolean;
}

/** Per-additional-million overage price, shared by the self-serve tiers. */
export const OVERAGE_PER_MILLION = "€25";

/** The Free tier's one-time lifetime allowance (events), never resets. Mirrors FREE_EVENT_CAP. */
export const FREE_EVENT_CAP = 5_000;

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: null,
    cadence: null,
    includedEvents: "5,000 events, once",
    eventCap: FREE_EVENT_CAP,
    summary: "A real trial, not a perpetual tier. The 5,000 events never reset.",
    retention: "7-day retention",
    retentionDays: 7,
    overage: "No overage. Capture pauses.",
    selfServe: false,
  },
  {
    id: "pro",
    name: "Pro",
    price: "€19",
    cadence: "/month",
    includedEvents: "500,000 events / month",
    eventCap: 500_000,
    summary: "For a service in production with real traffic.",
    retention: "30-day retention",
    retentionDays: 30,
    overage: `${OVERAGE_PER_MILLION} per extra million events`,
    featured: true,
    selfServe: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: "€99",
    cadence: "/month",
    includedEvents: "3,000,000 events / month",
    eventCap: 3_000_000,
    summary: "For high-volume ingestion and fan-out to many destinations.",
    retention: "90-day retention",
    retentionDays: 90,
    overage: `${OVERAGE_PER_MILLION} per extra million events`,
    selfServe: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    pricePrefix: "From",
    price: "€499",
    cadence: "/month",
    includedEvents: "20,000,000+ events / month",
    eventCap: null,
    summary: "Committed volume, and terms we agree up front.",
    retention: "Retention up to 1 year",
    retentionDays: null,
    overage: "Custom, agreed up front.",
    selfServe: false,
  },
] as const;

/** Index for O(1) lookup by id. */
const BY_ID: Readonly<Record<PlanId, Plan>> = Object.fromEntries(
  PLANS.map((p) => [p.id, p]),
) as Record<PlanId, Plan>;

/** The plan for `id`, or undefined for an unknown/legacy tier. */
export function planById(id: string): Plan | undefined {
  return (BY_ID as Record<string, Plan | undefined>)[id];
}

/** The tiers Checkout may sell, in ladder order (pro, scale). */
export const SELF_SERVE_PLANS: readonly Plan[] = PLANS.filter((p) => p.selfServe);
