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

import type { BillingPeriod } from "@webhook-co/shared";

import type { TenantTx } from "./client";

/** UTC midnight (ISO) of the day containing `nowMs` — the rolled/live boundary. UTC-pinned so the
 *  day bucket matches `rollup_usage`'s `date_trunc('day', … )` regardless of server timezone. */
export function utcDayStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
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
  const [rolledRow] = await tx<{ events: string }[]>`
    select coalesce(sum(event_count), 0)::bigint as events
    from usage
    where window_start >= ${period.start} and window_start < ${todayStart}`;
  const [todayRow] = await tx<{ events: string }[]>`
    select count(*)::bigint as events
    from events
    where received_at >= ${todayStart} and received_at < ${period.end}`;
  return Number(rolledRow?.events ?? 0) + Number(todayRow?.events ?? 0);
}
