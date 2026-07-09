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
// (no double-count at the boundary). `todayStart >= period.start` always: a billing cycle contains today,
// and the Free tier's lifetime window starts at org creation. A null `period.end` means OPEN-ENDED (the
// one-time Free allowance), so the upper bounds below drop away rather than clamping.

import { currentBillingPeriod, type EffectivePeriod } from "@webhook-co/shared";

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
 *   1. A non-canceled subscription AND `now` inside its cycle → the **Stripe cycle** (`billing_cycle`).
 *   2. A non-canceled subscription whose cycle has LAPSED (a late/missing renewal webhook) → the **UTC
 *      month** (`billing_cycle`). Deliberately NOT lifetime: a paying customer's lifetime usage would
 *      instantly exceed any cap and strand them paused mid-subscription.
 *   3. No subscription, or a CANCELED one → the Free tier's **one-time lifetime allowance**: an
 *      open-ended `[orgs.created_at, ∞)` window (`lifetime`, `end === null`). It never resets, so a
 *      churned paid org falls back here with its allowance long spent and stays paused until it
 *      resubscribes (upgrading re-anchors it to a fresh Stripe cycle → usage ≈ 0 → auto-resume).
 */
export async function effectiveBillingPeriod(
  tx: TenantTx,
  nowMs: number,
): Promise<EffectivePeriod> {
  const [sub] = await tx<{ start: Date; end: Date }[]>`
    select current_period_start as start, current_period_end as end
    from billing_subscriptions where status <> 'canceled'`;
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
  return {
    start: (org?.created_at ?? new Date(0)).toISOString(),
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
  const [todayRow] = await tx<{ events: string }[]>`
    select count(*)::bigint as events
    from events
    where received_at >= ${todayStart}
      and (${end}::timestamptz is null or received_at < ${end})`;
  return Number(rolledRow?.events ?? 0) + Number(todayRow?.events ?? 0);
}
