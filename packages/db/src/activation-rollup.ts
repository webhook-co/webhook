// The activation rollup orchestration (marketing measurement layer). Keeps the durable activation substrate
// — activation_org_milestones (first_capture/first_forward) and activation_org_weekly (per-ISO-week
// captured/forwarded flags) — current for every org with recent activity, so "weekly activated developers"
// and the signup→capture→forward funnel stay queryable off the hot path. Mirrors the delivery-stats rollup
// (delivery-stats-rollup.ts): enumerate active orgs cross-org as the least-privilege webhook_meter role,
// then per org re-roll under webhook_app RLS via the two SECURITY INVOKER rollup fns (migration 0092). There
// is no counter on any hot path — first-capture is MIN(events.received_at), first-forward is
// MIN(delivery_attempts WHERE status='forwarded'); the rollup only ever DERIVES from rows the product
// already writes. Idempotent + safe to retry: milestones are set-once via LEAST, weekly flags OR-accumulate.

import { rollupWindows } from "@webhook-co/shared";

import { withTenant, type Sql } from "./client";

/** Cap on orgs one pass processes — bounded + fairly (randomly) ordered so the tail is never starved across
 *  passes (mirrors the delivery-stats / metering rollups). Effectively uncapped at current scale. */
export const DEFAULT_ACTIVATION_ROLLUP_LIMIT = 1000;

/** Lookback depth re-rolled each run. Chooses WHICH orgs to re-roll (those with an event or forward in the
 *  window) and WHICH ISO weeks to re-roll (the weeks the window touches). Milestones are an absolute MIN
 *  scan, so a re-roll of any active org keeps first_capture/first_forward correct; a 2-day lookback under an
 *  hourly cron gives an org's first activity ~48 chances to be picked up even across a failed pass. */
export const ACTIVATION_SETTLE_DAYS = 2;

export interface ActivationRollupDeps {
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

export interface ActivationRollupResult {
  readonly orgsProcessed: number;
  readonly orgsSucceeded: number;
  readonly orgsFailed: number;
  readonly capped: boolean;
}

/** UTC-Monday (ISO-week start) of the day containing `iso`, as a YYYY-MM-DD string. rollup_activation_weekly
 *  re-truncates to Monday defensively, but passing the Monday keeps the set of re-rolled weeks minimal. */
function isoWeekMonday(iso: string): string {
  const d = new Date(iso);
  const backToMonday = (d.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat → days back to Monday
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - backToMonday);
  return new Date(monday).toISOString().slice(0, 10);
}

/**
 * Run one activation rollup pass. Enumerates orgs with an event OR a delivery in the settle window (fairly
 * ordered + capped — newly-signed-but-inactive orgs get their milestone row from the signup hook, not here),
 * then per org re-rolls milestones once and each touched ISO week under its tenant context. Idempotent + safe
 * to retry (set-once via LEAST, OR-accumulate). Each org is isolated: one org's blip is logged + counted and
 * the pass continues, so it can never block the rest.
 */
export async function runActivationRollup(
  deps: ActivationRollupDeps,
): Promise<ActivationRollupResult> {
  const windows = rollupWindows(deps.now, deps.settleDays);
  const oldest = windows[0];
  if (oldest === undefined) {
    return { orgsProcessed: 0, orgsSucceeded: 0, orgsFailed: 0, capped: false };
  }
  // The distinct ISO weeks the window touches (at most two: this week, and last week near a Monday boundary).
  const weeks = [...new Set(windows.map(isoWeekMonday))];

  // Cross-org enumeration (webhook_meter, read-only): orgs with a capture OR a forward since the oldest
  // window. webhook_meter can read events(org_id, received_at) + delivery_attempts(org_id, created_at) but
  // NOT delivery_attempts.status — the coarse "any delivery" superset is fine, the per-org rollup applies the
  // precise status='forwarded' filter. `union` (not `union all`) collapses to one row per org BEFORE the
  // random ordering, so the cap counts orgs, not rows.
  const rows = await deps.meter<Array<{ org_id: string }>>`
    select org_id from (
      select distinct org_id from events where received_at >= ${oldest}
      union
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
        // Belt-and-suspenders UTC pin. Both rollup fns already `set timezone='UTC'` at the function level
        // (migration 0092), so date_trunc('week', …) buckets on UTC-Monday regardless of the session TZ;
        // this tx-scoped pin keeps the driver consistent with the delivery-stats rollup and correct even if
        // that function attribute is ever dropped.
        await tx`set local time zone 'UTC'`;
        await tx`select rollup_activation_milestones()`;
        for (const week of weeks) {
          await tx`select rollup_activation_weekly(${week}::date)`;
        }
      });
      orgsSucceeded += 1;
    } catch (err) {
      orgsFailed += 1;
      deps.log?.("activation.rollup.org_failed", { orgId, error: String(err) });
    }
  }

  if (capped) deps.log?.("activation.rollup.capped", { count: orgIds.length, limit: deps.limit });
  return { orgsProcessed: orgIds.length, orgsSucceeded, orgsFailed, capped };
}
