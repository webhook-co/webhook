// S4.4d metering reconciliation oracle (money-correctness guard F6). Runs in the metering cron on a settle
// lag. For every FINALIZED usage day within a bounded lookback, it recounts the raw `events` rows FROM
// SCRATCH — via the independent webhook_meter_audit role + a different code path than the rollup — and
// compares that recount to the frozen `usage.event_count`. A drift means a rollup bug (F1–F3: a missed
// tail, a bad bucket, a dedup miscount) froze a WRONG billable count; the reconciler ALARMS on it (it never
// self-heals — the frozen count is the immutable billing snapshot, so a human decides how to correct).
//
// Independence is the whole point: the rollup COUNTS under webhook_app per-org; this recount reads events
// cross-org under a SEPARATE role, so a shared bug can't hide on both sides. Only finalized days are checked
// (an open day is still mutating); the recount is strictly per-org (grouped by org_id, so one tenant's
// events never inflate another's). NOTE: events retention is INFINITE today (no prune job), so a recount can
// never undershoot a frozen count — every drift is genuine. WHEN a prune/TTL is added, `lookbackDays` MUST
// stay within the retention window, or a pruned day would recount low and false-alarm.

import type { Sql } from "./client";

export interface MeterReconcileDeps {
  /** webhook_meter_audit connection — cross-org, read-only (events recount + frozen usage read). */
  readonly audit: Sql;
  /** Injected wall clock (ms) — the lookback window is measured back from this. */
  readonly now: number;
  /** How many days back to reconcile (bounds the scan; must stay within the events retention window). */
  readonly lookbackDays: number;
  /** Max drifts to surface in one pass (the alarm list is bounded; `capped` flags truncation). */
  readonly limit: number;
  /** Optional structured logger; only non-PII fields (org id, day, counts) are passed. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** One reconciled day whose frozen rollup count disagrees with a fresh events recount. */
export interface MeterUsageDrift {
  readonly orgId: string;
  /** The UTC day (YYYY-MM-DD). */
  readonly day: string;
  /** The frozen `usage.event_count` (the billing snapshot). */
  readonly rollup: number;
  /** The independent recount of raw `events` for that org+day. */
  readonly recount: number;
}

export interface MeterReconcileResult {
  /** Finalized usage days in the lookback window that were compared. */
  readonly daysChecked: number;
  /** The days whose frozen count disagreed with the recount (empty = metering is consistent). */
  readonly mismatches: readonly MeterUsageDrift[];
  /** True when the drift list hit `limit` (possibly truncated) — investigate + widen the pass. */
  readonly capped: boolean;
}

/** Default reconciliation lookback (days). Wide enough to cover late finalization + a missed pass. */
export const DEFAULT_METER_RECONCILE_LOOKBACK_DAYS = 35;
/** Default cap on drifts surfaced per pass. */
export const DEFAULT_METER_RECONCILE_LIMIT = 1000;

/** UTC-midnight ISO of the day `lookbackDays` before `nowMs` — the earliest day the pass reconciles. */
function lookbackHorizonIso(nowMs: number, lookbackDays: number): string {
  const d = new Date(nowMs);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(todayStart - lookbackDays * 86_400_000).toISOString();
}

export async function reconcileMeteringUsage(
  deps: MeterReconcileDeps,
): Promise<MeterReconcileResult> {
  const horizon = lookbackHorizonIso(deps.now, deps.lookbackDays);

  // One UTC-pinned transaction: `set local time zone 'UTC'` so date_trunc('day', received_at) buckets on
  // UTC midnight IDENTICALLY to the rollup's window_start (a TZ drift would misalign the join and false-drift).
  return deps.audit.begin(async (tx) => {
    await tx`set local time zone 'UTC'`;

    const [checkedRow] = await tx<{ checked: string }[]>`
      select count(*)::bigint as checked
      from usage
      where finalized_at is not null and window_start >= ${horizon}`;

    // Definition B: recount BOTH legs — captures and delivery dispatches — from scratch, on this separate
    // code path and role. Critically, each day is recounted under the basis that PRODUCED it
    // (`usage.counts_deliveries`): rows finalized before Definition B landed were counted capture-only and
    // are immutable (F1), so adding deliveries to their recount would report drift on every historical day
    // and drown the real signal. One `delivery_attempts` row = one dispatch; retries update it in place.
    const rows = await tx<{ org_id: string; day: string; rollup: string; recount: string }[]>`
      with captures as (
        select org_id, date_trunc('day', received_at) as day, count(*)::bigint as n
        from events
        where received_at >= ${horizon}
        group by org_id, date_trunc('day', received_at)
      ),
      dispatches as (
        select org_id, date_trunc('day', created_at) as day, count(*)::bigint as n
        from delivery_attempts
        where created_at >= ${horizon}
        group by org_id, date_trunc('day', created_at)
      )
      select u.org_id,
             to_char(u.window_start, 'YYYY-MM-DD') as day,
             u.event_count::text as rollup,
             (coalesce(c.n, 0) + case when u.counts_deliveries then coalesce(d.n, 0) else 0 end)::text
               as recount
      from usage u
      left join captures c on c.org_id = u.org_id and c.day = u.window_start
      left join dispatches d on d.org_id = u.org_id and d.day = u.window_start
      where u.finalized_at is not null
        and u.window_start >= ${horizon}
        and u.event_count
            <> coalesce(c.n, 0) + case when u.counts_deliveries then coalesce(d.n, 0) else 0 end
      order by u.window_start, u.org_id
      limit ${deps.limit}`;

    const mismatches: MeterUsageDrift[] = rows.map((r) => ({
      orgId: r.org_id,
      day: r.day,
      rollup: Number(r.rollup),
      recount: Number(r.recount),
    }));
    const capped = mismatches.length >= deps.limit;

    // Alarm on each drift (a billable count disagreeing with the source events is money-critical). Counts +
    // the opaque org id only — no payload/header content is ever read on this path.
    for (const m of mismatches) {
      deps.log?.("metering.reconcile.drift", {
        orgId: m.orgId,
        day: m.day,
        rollup: m.rollup,
        recount: m.recount,
      });
    }

    return { daysChecked: Number(checkedRow?.checked ?? 0), mismatches, capped };
  });
}
