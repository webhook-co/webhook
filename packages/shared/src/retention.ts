// Per-plan data-retention policy (data-lifecycle slice 2.3). ONE source of truth for:
//   * the engine prune cron — how old an org's events may get before they (and their R2 payload bodies)
//     are deleted;
//   * the meter-reconcile lookback — the money-correctness guard must not recount a day whose events may
//     already be pruned, or it false-alarms;
//   * the public pricing page + docs — the retention window is a customer-facing PROMISE per tier.
//
// Windows are a PRODUCT decision (not a dark flag): the numbers below are the promise regardless of whether
// the prune cron is live yet. Founder-set 2026-07-11: Free 7d / Pro 30d / Scale 90d / Enterprise unlimited,
// enforced immediately (no phase-in). While billing is dark every org is Free, so only the 7-day window can
// enforce today; the prune cron EXCLUDES entitled (paid) orgs so a paying customer is never pruned at the
// Free window before per-plan enforcement is wired at billing activation (over-retention is the safe miss).

/** The Free-tier retention window (days). The only tier that can enforce while billing is dark. */
export const FREE_RETENTION_DAYS = 7;

// ⚠️ These are the values the PRICING PAGE advertises. They are NOT what the prune reads at runtime: the
// window it enforces lives on `orgs.retention_days`, mirrored from each plan's Stripe price metadata
// (`retention_days`) by billing-sync, and enforced by the DELETE policy in migration 0054. This map is the
// human-facing source of truth used to keep the pricing copy honest — if you change a number here, change
// the matching Stripe price metadata too, or the page will advertise a window the database doesn't keep.

/**
 * Retention window per plan tier, in days. `null` = unlimited (never pruned). The keys are tier NAMES
 * (`free`/`pro`/`scale`/`enterprise`), the same intensity vocabulary as {@link SELF_SERVE_PLAN_IDS};
 * `free` is the implicit no-subscription tier. These MUST match the public pricing ladder's retention
 * strings — apps/www/src/components/marketing/pricing-tiers.ts. Enterprise is `null` (never auto-pruned)
 * because its window is contractual/negotiated; the pricing page states it publicly as "up to 1 year".
 */
export const PLAN_RETENTION_DAYS: Readonly<Record<string, number | null>> = {
  free: FREE_RETENTION_DAYS,
  pro: 30,
  scale: 90,
  enterprise: null,
} as const;

/**
 * Resolve a plan tier name to its retention window (days), or `null` for unlimited. FAILS SAFE: an
 * unrecognised plan id returns `null` (unlimited), never a short window — pruning an unknown/paid tier at
 * the aggressive Free window would delete a paying customer's data, so the default keeps everything.
 */
export function retentionDaysForPlan(plan: string): number | null {
  return plan in PLAN_RETENTION_DAYS ? (PLAN_RETENTION_DAYS[plan] ?? null) : null;
}

/**
 * The meter-reconcile lookback (days) to use ONCE the retention prune is active. The prune deletes events
 * with `received_at < now() - FREE_RETENTION_DAYS` (a rolling timestamp), while the reconciler recounts
 * whole UTC days from `now()-lookback`. Because `now()` can be up to ~24h into the current UTC day, a
 * reconciled day at exactly `now()-FREE_RETENTION_DAYS` could still hold events past the rolling cutoff —
 * so the safe lookback is `FREE_RETENTION_DAYS - 1`. At 6 days no reconciled UTC day can overlap a pruned
 * event, so the money-guard never sees a pruned day recount low and false-alarm. (Shrinking coverage from
 * 35→6 days is the deliberate cost of a live prune; revisit per-org when paid tiers get real windows.)
 */
export const RETENTION_ACTIVE_RECONCILE_LOOKBACK_DAYS = FREE_RETENTION_DAYS - 1;

/** The wide default reconcile lookback (days) while no prune runs — mirrors DEFAULT_METER_RECONCILE_LOOKBACK_DAYS. */
export const RETENTION_INACTIVE_RECONCILE_LOOKBACK_DAYS = 35;

/**
 * Pick the meter-reconcile lookback given whether the retention prune is active (i.e. the retention
 * Hyperdrive/role is provisioned). Wide (35d) while inactive for maximum money-guard coverage; clamped
 * strictly inside the Free window (6d) once the prune can delete events, so a pruned day is never recounted.
 */
export function reconcileLookbackDays(retentionActive: boolean): number {
  return retentionActive
    ? RETENTION_ACTIVE_RECONCILE_LOOKBACK_DAYS
    : RETENTION_INACTIVE_RECONCILE_LOOKBACK_DAYS;
}
