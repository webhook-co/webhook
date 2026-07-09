// The ONE definition of "this org's event usage for the billing period", shared by the usage SURFACE
// (readUsageSummary — what the dashboard/API/CLI show) and the soft-cap ENFORCEMENT (runCapProducer —
// what decides pause/resume). They MUST agree on the same number, or the surface and enforcement drift
// (an org shows over-cap while still capturing, or resumes while still over). Both run inside a tenant
// tx (withTenant / webhook_app), so RLS pins the org and this never filters by org_id itself.
//
// Basis = the rolled-up `usage` windows for the period's PRIOR days + a LIVE count of TODAY's billed events.
// A BILLED EVENT is one inbound CAPTURE or one outbound delivery DISPATCH (Definition B, ADR-0004 amended
// 2026-07-09); retries are never billed, because a retry updates its `delivery_attempts` row in place.
// The hourly rollup re-rolls today, so summing `usage` alone reads today low (or 0) between ticks; the
// live today-count fixes that WITHOUT depending on when the rollup last ran. The split is half-open and
// non-overlapping — `window_start < todayStart` for the rolled half, `received_at >= todayStart` for the
// live half — so a `usage` row that already exists for TODAY is never added on top of the live count
// (no double-count at the boundary). `todayStart >= period.start` always, because BOTH period starts are
// floored to UTC midnight: a billing cycle contains today, and the lifetime window starts on the org's
// creation DAY. A null `period.end` means OPEN-ENDED (the one-time Free allowance), so the upper bounds
// below drop away rather than clamping.

import {
  BILLING_ACTIVE_STATUSES,
  currentBillingPeriod,
  type EffectivePeriod,
} from "@webhook-co/shared";

import type { TenantTx } from "./client";

/** UTC midnight (ISO) of the day containing `nowMs` — the rolled/live boundary. UTC-pinned so the
 *  day bucket matches `rollup_usage`'s `date_trunc('day', … )` regardless of server timezone. */
export function utcDayStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * The org's EFFECTIVE billing period — the ONE period basis for BOTH the soft-cap enforcement and the usage
 * surface, so what an org is shown can never drift from what it is enforced at. Runs inside the tenant tx
 * (webhook_app / RLS), so both reads are org-scoped. Three cases (ADR-0004, amended 2026-07-09):
 *
 *   1. An ENTITLED subscription (`isBillingActive` — active/trialing/past_due) AND `now` inside its cycle →
 *      the **Stripe cycle** (`billing_cycle`).
 *   2. An ENTITLED subscription whose cycle has LAPSED (a late/missing renewal webhook) → the **UTC
 *      month** (`billing_cycle`). Deliberately NOT lifetime: a paying customer's lifetime usage would
 *      instantly exceed any cap and strand them paused mid-subscription.
 *   3. No subscription, or a NON-ENTITLED one (canceled/unpaid/incomplete/paused) → the Free tier's
 *      **one-time lifetime allowance**: an open-ended `[org creation day, ∞)` window (`lifetime`,
 *      `end === null`). It never resets, so a churned paid org falls back here with its allowance long
 *      spent and stays paused until it resubscribes (upgrading re-anchors it to a fresh Stripe cycle →
 *      usage ≈ 0 → auto-resume).
 *
 * Case 3 tests ENTITLEMENT, not `status <> 'canceled'`: Stripe only writes `canceled` on an explicit
 * `subscription.deleted`, so a denylist would leave an `unpaid` (dunning exhausted) or `incomplete_expired`
 * (never paid) org on the monthly-resetting paid basis forever — a free paid plan.
 */
export async function effectiveBillingPeriod(
  tx: TenantTx,
  nowMs: number,
): Promise<EffectivePeriod> {
  // The allowlist crosses as ONE text param split server-side (no status contains a comma) — the tenant-tx
  // wrapper doesn't reach postgres.js's array serializer, and a literal `in (…)` list would inline the values.
  const [sub] = await tx<{ start: Date; end: Date }[]>`
    select current_period_start as start, current_period_end as end
    from billing_subscriptions
    where status = any(string_to_array(${BILLING_ACTIVE_STATUSES.join(",")}, ','))`;
  if (sub) {
    const startMs = sub.start.getTime();
    const endMs = sub.end.getTime();
    // Only anchor to the Stripe cycle while `now` is actually WITHIN it.
    if (nowMs >= startMs && nowMs < endMs) {
      // FLOOR the start to UTC midnight. `usage` is UTC-day-bucketed (rollup_usage date_trunc('day')), so a
      // non-midnight Stripe start would exclude the start-day bucket (window_start = midnight < start) and
      // persistently UNDER-count. Flooring includes the whole start day — a bounded, one-day-per-cycle,
      // CONSERVATIVE over-count on the start day only. (The exact-instant boundary split is the outbound
      // meter-reporter's F4 job — the soft-cap accepts day granularity.) The end stays the raw instant: it
      // only bounds the LIVE half (raw events), which is instant-precise, and `now < end` here.
      return { start: utcDayStartIso(startMs), end: sub.end.toISOString(), kind: "billing_cycle" };
    }
    // Lapsed cycle → UTC month (a safe, self-correcting fallback until the renewal webhook lands).
    const month = currentBillingPeriod(nowMs);
    return { start: month.start, end: month.end, kind: "billing_cycle" };
  }
  // Free: the ONE-TIME lifetime allowance, anchored at org creation and never closed.
  const [org] = await tx<{ created_at: Date }[]>`select created_at from orgs`;
  // FLOOR to UTC midnight, for the same day-bucket reason as the cycle start above: `usage.window_start` is
  // the org's creation DAY at midnight, which sorts BEFORE a mid-day `created_at`. Anchoring at the raw
  // instant would exclude the signup-day bucket from the rolled half forever (it's only counted live, on day
  // 0), so every org's entire first-day volume would escape the lifetime cap — the whole allowance is
  // trivially bypassed by bursting on signup day. Flooring costs nothing: no event can predate its org.
  return {
    start: utcDayStartIso((org?.created_at ?? new Date(0)).getTime()),
    end: null,
    kind: "lifetime",
  };
}

/**
 * The org's event count for `period` as of `nowMs`: rolled prior-day `usage` + a live count of today's
 * `events`. Deterministic given the DB state + clock, so the surface and the cap producer can't drift.
 * A null `period.end` is OPEN-ENDED (the one-time lifetime allowance) — no upper bound is applied.
 */
export async function sumPeriodEventUsage(
  tx: TenantTx,
  period: { readonly start: string; readonly end: string | null },
  nowMs: number,
): Promise<number> {
  const todayStart = utcDayStartIso(nowMs);
  const end = period.end; // null ⇒ open-ended; the `is null or` arms below drop the upper bound
  // The rolled half is upper-bounded by BOTH todayStart (today is counted live below) AND period.end — the
  // latter so a period that ended before now (a lapsed cycle a caller didn't clamp) can't accumulate usage
  // from days past its end. In the normal in-period case now < period.end, so todayStart is the tighter bound.
  const [rolledRow] = await tx<{ events: string }[]>`
    select coalesce(sum(event_count), 0)::bigint as events
    from usage
    where window_start >= ${period.start}
      and window_start < ${todayStart}
      and (${end}::timestamptz is null or window_start < ${end})`;
  // Definition B: a billed event is one inbound CAPTURE or one outbound delivery DISPATCH. The live half
  // must count BOTH legs, or today's deliveries stay invisible to the cap until the rollup lands, and the
  // usage surface would disagree with enforcement. One `delivery_attempts` row = one dispatch: the enqueue
  // inserts it and every retry UPDATES it in place, so `count(*)` can never bill a retry.
  const [todayRow] = await tx<{ events: string }[]>`
    select (
      (select count(*) from events
        where received_at >= ${todayStart}
          and (${end}::timestamptz is null or received_at < ${end}))
      +
      (select count(*) from delivery_attempts
        where created_at >= ${todayStart}
          and (${end}::timestamptz is null or created_at < ${end}))
    )::bigint as events`;
  return Number(rolledRow?.events ?? 0) + Number(todayRow?.events ?? 0);
}
