// The metering-rollup orchestration (S4.1). Usage is DERIVED from the exactly-once
// `events` rows (rollup_usage, migration 0007/0040) — there is no counter on the ingest
// hot path (constitution: never build hidden per-step counters). This cron drives the
// rollup off the hot path:
//   - enumerate orgs needing work as the least-privilege cross-org webhook_meter role;
//   - per org, under webhook_app RLS with the session pinned to UTC, re-roll the
//     settle-window days and FREEZE any day older than the window.
// The window math + money-correctness rationale (F1 immutable snapshot, F2 no
// pre-midnight-tail loss, F4 UTC alignment) live in the pure helpers rollupWindows /
// finalizeCutoff (@webhook-co/shared).

import { finalizeCutoff, rollupWindows } from "@webhook-co/shared";

import { withTenant, type Sql } from "./client";

/** Default cap on orgs one rollup pass processes. A bounded, fairly-ordered pass stays under the
 *  Workers cron ceiling and — because the ordering is random — never starves the tail across passes
 *  (mirrors the reconciler's DEFAULT_RECONCILE_LIMIT). At current scale this is effectively uncapped. */
export const DEFAULT_METERING_ROLLUP_LIMIT = 1000;

export interface UsageRollupDeps {
  /** webhook_meter connection — cross-org enumeration ONLY (read-only, column-scoped). */
  readonly meter: Sql;
  /** webhook_app connection — per-org rollup + freeze, under RLS via withTenant. */
  readonly app: Sql;
  /** Injected wall clock (ms since epoch) so windows are deterministic + testable. */
  readonly now: number;
  /** Lookback days re-rolled each run before a day is frozen; >=1 (the F2 minimum). */
  readonly settleDays: number;
  /** Max orgs one pass processes (fairly ordered so the tail isn't starved). */
  readonly limit: number;
  /** Optional structured logger; only non-PII fields (org id, counts) are passed. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface UsageRollupResult {
  /** Orgs enumerated this pass (bounded by `limit`; recent events ∪ stale-open usage). */
  readonly orgsProcessed: number;
  /** Orgs whose rollup + freeze committed cleanly. */
  readonly orgsSucceeded: number;
  /** Orgs whose pass threw (logged + counted, non-fatal; a next pass retries — idempotent). */
  readonly orgsFailed: number;
  /** Usage-day rows frozen (finalized_at set) this pass. */
  readonly daysFinalized: number;
  /** True when the pass read exactly `limit` orgs — more may remain for the next pass. */
  readonly capped: boolean;
}

/**
 * Run one metering-rollup pass. Enumerates orgs with recent events OR a stale-open usage day (so
 * an org that stopped sending still gets its last day frozen), fairly ordered + capped, then per
 * org rolls the settle-window days and finalizes aged days. Idempotent + safe to retry: re-rolling
 * recomputes the same open-day counts, and a frozen day is never recounted.
 *
 * Each org is isolated: a single org's failure (a transient Hyperdrive blip, bad data) is logged +
 * counted and the pass continues, so one bad org can never block metering for the rest.
 *
 * Known bound (addressed in S4.3): the enumeration self-heals only within the settle window — a cron
 * outage longer than `settleDays` can leave an aged day with no usage row, silently excluded. S4.3
 * adds the rollup-staleness watchdog + a catch-up path; until then the hourly cadence keeps the
 * exposure to a multi-day outage.
 */
export async function runUsageRollup(deps: UsageRollupDeps): Promise<UsageRollupResult> {
  const windows = rollupWindows(deps.now, deps.settleDays);
  const cutoff = finalizeCutoff(deps.now, deps.settleDays);
  const oldest = windows[0];
  // settleDays >= 0 always yields >= 1 window; guard keeps the type honest (and no-ops a
  // nonsensical negative settleDays rather than querying with an undefined bound).
  if (oldest === undefined) {
    return { orgsProcessed: 0, orgsSucceeded: 0, orgsFailed: 0, daysFinalized: 0, capped: false };
  }

  // Cross-org enumeration (webhook_meter, read-only): orgs to roll ∪ orgs to freeze. Deduped,
  // randomly ordered for cross-pass fairness, and capped so a pass stays bounded. `distinct` on the
  // events half collapses per-event rows before the union so the cap counts orgs, not events.
  const rows = await deps.meter<Array<{ org_id: string }>>`
    select org_id from (
      select distinct org_id from events where received_at >= ${oldest}
      union
      -- Definition B: a DISPATCH is a billed event too, so an org whose only recent activity was an
      -- outbound delivery (e.g. replaying an older event) must still be enumerated — otherwise its
      -- window is never rolled and those billed events are silently given away.
      select distinct org_id from delivery_attempts where created_at >= ${oldest}
      union
      select org_id from usage where finalized_at is null and window_start < ${cutoff}
    ) t
    order by random()
    limit ${deps.limit}`;
  const orgIds: string[] = rows.map((r) => r.org_id);
  const capped = orgIds.length >= deps.limit;

  let orgsSucceeded = 0;
  let orgsFailed = 0;
  let daysFinalized = 0;
  for (const orgId of orgIds) {
    try {
      const frozen = await withTenant(deps.app, orgId, async (tx) => {
        // Pin UTC so date_trunc('day', …) in rollup_usage buckets on UTC midnight regardless of the
        // connection's default TimeZone (F4 — a TZ drift would misalign the bucket). tx-scoped.
        await tx`set local time zone 'UTC'`;
        // Skip a `deleting` org (#665): requestOrgDeletion already WAIVED its usage, and the webhook_reaper
        // cron is draining its events chunk by chunk. Re-rolling those still-present events into a fresh
        // frozen usage snapshot would resurrect the exact F6 reconcile drift the waive removed (the reaper
        // then deletes the counted events out from under the frozen count). The metering roles hold no `orgs`
        // grant to filter the cross-org enumeration on, so the guard lives HERE — the per-org webhook_app tx
        // that can read `orgs.status`. (`!org` can't happen for an enumerated org — events FK to a live orgs
        // row and the reaper drops the row only after the events are gone — but skip defensively.)
        const [org] = await tx<{ status: string }[]>`select status from orgs where id = ${orgId}`;
        if (!org || org.status === "deleting") return 0;
        for (const w of windows) {
          await tx`select rollup_usage(${w})`;
        }
        const result = await tx`
          update usage set finalized_at = now()
          where finalized_at is null and window_start < ${cutoff}`;
        return result.count;
      });
      daysFinalized += frozen;
      orgsSucceeded += 1;
    } catch (err) {
      // One org's blip must not skip every org after it in the pass; surface + continue.
      orgsFailed += 1;
      deps.log?.("metering.rollup.org_failed", { orgId, error: String(err) });
    }
  }

  if (capped) deps.log?.("metering.rollup.capped", { count: orgIds.length, limit: deps.limit });
  return { orgsProcessed: orgIds.length, orgsSucceeded, orgsFailed, daysFinalized, capped };
}
