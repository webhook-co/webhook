// The ONE definition of "this org's event usage for the billing period", shared by the usage SURFACE
// (readUsageSummary — what the dashboard/API/CLI show) and the soft-cap ENFORCEMENT (runCapProducer —
// what decides pause/resume). They MUST agree on the same number, or the surface and enforcement drift
// (an org shows over-cap while still capturing, or resumes while still over). Both run inside a tenant
// tx (withTenant / webhook_app), so RLS pins the org and this never filters by org_id itself.
//
// Basis = the rolled-up `usage` windows for the period's PRIOR days + a LIVE count of TODAY's `events`.
// The hourly rollup re-rolls today, so summing `usage` alone reads today low (or 0) between ticks; the
// live today-count fixes that WITHOUT depending on when the rollup last ran. The split is half-open and
// non-overlapping — `window_start < todayStart` for the rolled half, `received_at >= todayStart` for the
// live half — so a `usage` row that already exists for TODAY is never added on top of the live count
// (no double-count at the boundary). `todayStart >= period.start` always (today is within the period).

import { currentBillingPeriod, type BillingPeriod } from "@webhook-co/shared";

import type { TenantTx } from "./client";

/** UTC midnight (ISO) of the day containing `nowMs` — the rolled/live boundary. UTC-pinned so the
 *  day bucket matches `rollup_usage`'s `date_trunc('day', … )` regardless of server timezone. */
export function utcDayStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * The org's EFFECTIVE billing period: a PAID org's Stripe-anchored cycle (billing_subscriptions
 * current_period_start/end) when it has a non-canceled subscription, else the UTC calendar month (the Free
 * default). This is the ONE period basis for BOTH the soft-cap enforcement and the usage surface, so a paid
 * org's usage/cap/pause is measured over its real billing cycle — not the wrong UTC month. Runs inside the
 * tenant tx (webhook_app / RLS), so the subscription read is org-scoped. A canceled subscription falls back
 * to the UTC month (its org_limits paid cap was removed → Free), keeping the period + cap consistent.
 */
export async function effectiveBillingPeriod(tx: TenantTx, nowMs: number): Promise<BillingPeriod> {
  const [sub] = await tx<{ start: Date; end: Date }[]>`
    select current_period_start as start, current_period_end as end
    from billing_subscriptions where status <> 'canceled'`;
  if (sub) {
    const startMs = sub.start.getTime();
    const endMs = sub.end.getTime();
    // Only anchor to the Stripe cycle while `now` is actually WITHIN it. A lapsed cycle (now past
    // current_period_end — a late/missing renewal webhook) falls back to the UTC month, so a paid org is
    // never measured over a stale/ended window (which could strand it paused into a fresh cycle).
    if (nowMs >= startMs && nowMs < endMs) {
      // FLOOR the start to UTC midnight. `usage` is UTC-day-bucketed (rollup_usage date_trunc('day')), so a
      // non-midnight Stripe start would exclude the start-day bucket (window_start = midnight < start) and
      // persistently UNDER-count. Flooring includes the whole start day — a bounded, one-day-per-cycle,
      // CONSERVATIVE over-count on the start day only. (The exact-instant boundary split is the outbound
      // meter-reporter's F4 job — the soft-cap accepts day granularity.) The end stays the raw instant: it
      // only bounds the LIVE half (raw events), which is instant-precise, and `now < end` here.
      return { start: utcDayStartIso(startMs), end: sub.end.toISOString() };
    }
  }
  return currentBillingPeriod(nowMs);
}

/**
 * The org's event count for `period` as of `nowMs`: rolled prior-day `usage` + a live count of today's
 * `events`. Deterministic given the DB state + clock, so the surface and the cap producer can't drift.
 */
export async function sumPeriodEventUsage(
  tx: TenantTx,
  period: BillingPeriod,
  nowMs: number,
): Promise<number> {
  const todayStart = utcDayStartIso(nowMs);
  // The rolled half is upper-bounded by BOTH todayStart (today is counted live below) AND period.end — the
  // latter so a period that ended before now (a lapsed cycle a caller didn't clamp) can't accumulate usage
  // from days past its end. In the normal in-period case now < period.end, so todayStart is the tighter bound.
  const [rolledRow] = await tx<{ events: string }[]>`
    select coalesce(sum(event_count), 0)::bigint as events
    from usage
    where window_start >= ${period.start}
      and window_start < ${todayStart}
      and window_start < ${period.end}`;
  const [todayRow] = await tx<{ events: string }[]>`
    select count(*)::bigint as events
    from events
    where received_at >= ${todayStart} and received_at < ${period.end}`;
  return Number(rolledRow?.events ?? 0) + Number(todayRow?.events ?? 0);
}
