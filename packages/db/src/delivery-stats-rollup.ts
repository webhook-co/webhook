// The delivery-stats rollup orchestration (Lane 1.1). A daily per-org rollup of outbound-delivery outcomes
// (counts by terminal status + p95 latency), so the /dashboard overview reads O(days) not O(deliveries).
// Mirrors the metering rollup (usage-rollup.ts) — enumerate orgs cross-org as the least-privilege
// webhook_meter role, then re-roll the settle-window days per org under webhook_app RLS — but SIMPLER: this
// is a display cache, not billing, so there is no finalize/immutability freeze. Recent days just refine as
// deliveries settle (a delivery can retry for ~28h), which the upsert in rollup_delivery_stats handles.

import { rollupWindows } from "@webhook-co/shared";

import { withTenant, type Sql, type TenantTx } from "./client";

/** Cap on orgs one pass processes — bounded + fairly (randomly) ordered so the tail is never starved across
 *  passes (mirrors the metering rollup). Effectively uncapped at current scale. */
export const DEFAULT_DELIVERY_STATS_ROLLUP_LIMIT = 1000;

/** Days re-rolled each run. A delivery can retry for ~28h, so a 2-day window catches a delivery created near
 *  the end of yesterday that only reaches a terminal status today — its day's counts refine on this pass. */
export const DELIVERY_STATS_SETTLE_DAYS = 2;

export interface DeliveryStatsRollupDeps {
  /** webhook_meter connection — cross-org org enumeration ONLY (read-only, column-scoped). */
  readonly meter: Sql;
  /** webhook_app connection — per-org rollup under RLS via withTenant. */
  readonly app: Sql;
  /** Injected wall clock (ms since epoch) so the windows are deterministic + testable. */
  readonly now: number;
  /** Lookback days re-rolled each run; >= 1. */
  readonly settleDays: number;
  /** Max orgs one pass processes (fairly ordered so the tail isn't starved). */
  readonly limit: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface DeliveryStatsRollupResult {
  readonly orgsProcessed: number;
  readonly orgsSucceeded: number;
  readonly orgsFailed: number;
  readonly capped: boolean;
}

/**
 * Run one delivery-stats rollup pass. Enumerates orgs with a delivery in the settle window (fairly ordered +
 * capped), then per org re-rolls each window day via rollup_delivery_stats under its tenant context.
 * Idempotent + safe to retry (the upsert recomputes). Each org is isolated: one org's blip is logged +
 * counted and the pass continues, so it can never block the rest.
 */
export async function runDeliveryStatsRollup(
  deps: DeliveryStatsRollupDeps,
): Promise<DeliveryStatsRollupResult> {
  const windows = rollupWindows(deps.now, deps.settleDays);
  const oldest = windows[0];
  if (oldest === undefined) {
    return { orgsProcessed: 0, orgsSucceeded: 0, orgsFailed: 0, capped: false };
  }

  // Cross-org enumeration (webhook_meter, read-only): orgs with a delivery since the oldest window. `distinct`
  // collapses per-delivery rows to one per org BEFORE the random ordering so the cap counts orgs, not rows.
  const rows = await deps.meter<Array<{ org_id: string }>>`
    select org_id from (
      select distinct org_id from delivery_attempts where created_at >= ${oldest}
    ) t
    order by random()
    limit ${deps.limit}`;
  const orgIds = rows.map((r) => r.org_id);
  const capped = orgIds.length >= deps.limit;

  let orgsSucceeded = 0;
  let orgsFailed = 0;
  for (const orgId of orgIds) {
    try {
      await withTenant(deps.app, orgId, async (tx) => {
        // Pin UTC so date_trunc('day', …) in rollup_delivery_stats buckets on UTC midnight regardless of the
        // connection's default TimeZone (a TZ drift would misalign the bucket). tx-scoped.
        await tx`set local time zone 'UTC'`;
        for (const w of windows) {
          await tx`select rollup_delivery_stats(${w})`;
        }
      });
      orgsSucceeded += 1;
    } catch (err) {
      orgsFailed += 1;
      deps.log?.("delivery_stats.rollup.org_failed", { orgId, error: String(err) });
    }
  }

  if (capped)
    deps.log?.("delivery_stats.rollup.capped", { count: orgIds.length, limit: deps.limit });
  return { orgsProcessed: orgIds.length, orgsSucceeded, orgsFailed, capped };
}

/** One day of a delivery-outcome series for the dashboard. */
export interface DeliveryStatsDay {
  /** UTC day (ISO). */
  readonly windowStart: string;
  readonly delivered: number;
  readonly dead: number;
  readonly blocked: number;
  /** p95 POST latency (ms) across delivered rows that day; null = none measured (tile shows "—"). */
  readonly p95DurationMs: number | null;
}

/**
 * Read the last `days` of an org's delivery-outcome series (oldest→newest) for the /dashboard overview. Runs
 * under the caller's RLS context (withTenant), so it returns exactly this org's rows. A day with no
 * deliveries has no row — the dashboard treats a gap as zero. Bounded (≤ days rows) and PK-index-served.
 */
export async function readDeliveryStatsSeries(
  tx: TenantTx,
  days: number,
  nowMs: number = Date.now(),
): Promise<DeliveryStatsDay[]> {
  // Compute the UTC-midnight cutoff in JS (not in SQL) so it can't misalign against the session's default
  // TimeZone — window_start is stored at UTC midnight (the rollup pins UTC), so the boundary must be too.
  const t = new Date(nowMs);
  const cutoff = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - (days - 1)),
  );
  const rows = await tx<
    Array<{
      window_start: Date;
      delivered_count: string | number;
      dead_count: string | number;
      blocked_count: string | number;
      p95_duration_ms: number | null;
    }>
  >`
    select window_start, delivered_count, dead_count, blocked_count, p95_duration_ms
    from delivery_stats
    where window_start >= ${cutoff}
    order by window_start`;
  return rows.map((r) => ({
    windowStart: r.window_start.toISOString(),
    delivered: Number(r.delivered_count),
    dead: Number(r.dead_count),
    blocked: Number(r.blocked_count),
    p95DurationMs: r.p95_duration_ms,
  }));
}
