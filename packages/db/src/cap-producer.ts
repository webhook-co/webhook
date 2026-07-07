// The soft-cap producer (S4.3). Runs in the metering cron right AFTER the rollup: for each org it
// compares the current billing period's usage against the org's effective cap and, on a pause↔resume
// TRANSITION, flips the durable `ingest_paused` flag (the source of truth the cached ingest signal
// mirrors) and fires edge cache eviction so the pause takes effect promptly. The cap→pause decision
// itself is the pure `shouldPauseForCap` (packages/shared/metering) — deterministic, unit-tested. The
// cap is a soft cap: enforcement is eventually-consistent (rollup lag + cache), never a hot-path count.

import { currentBillingPeriod, shouldPauseForCap, type PausePolicy } from "@webhook-co/shared";

import { withTenant, type Sql } from "./client";

/** Default cap on orgs one producer pass processes (bounded + fairly ordered — mirrors the rollup). */
export const DEFAULT_CAP_PRODUCER_LIMIT = 1000;

export interface CapProducerDeps {
  /** webhook_meter connection — cross-org enumeration ONLY (read-only, column-scoped). */
  readonly meter: Sql;
  /** webhook_app connection — per-org read (usage/limits/pause) + write (ingest_paused), under RLS. */
  readonly app: Sql;
  /** Injected wall clock (ms) so the period + `since` are deterministic + testable. */
  readonly now: number;
  /**
   * Event cap for orgs with NO org_limits row — the Free-tier ceiling. Injected from non-public config
   * (deploy env), NEVER a literal in this repo: a cap value is a tier figure. `null` = uncapped default.
   * An org WITH an org_limits row uses that row's event_cap (which may itself be null = uncapped).
   */
  readonly defaultEventCap: number | null;
  /** Max orgs one pass processes (fairly ordered so the tail isn't starved). */
  readonly limit: number;
  /** Optional structured logger; only non-PII fields (org id, counts) are passed. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Fired on each pause↔resume TRANSITION (after the durable ingest_paused write commits) so the ingest
   * KV cache reflects it promptly — the edge eviction. Best-effort: a throw is logged, not fatal; the
   * ingest_paused row is the SoT and the cache's TTL is the backstop. `paused` is the new state.
   */
  readonly onTransition?: (orgId: string, paused: boolean) => Promise<void>;
}

export interface CapProducerResult {
  readonly orgsProcessed: number;
  readonly pausedTransitions: number;
  readonly resumedTransitions: number;
  /** Orgs whose pass threw (logged + counted, non-fatal; a next pass retries — idempotent). */
  readonly orgsFailed: number;
  /**
   * True when the candidate set hit `limit` (enumeration truncated) — enforcement for the unprocessed
   * tail lags to a later pass. An operability signal: a persistently-`capped` producer means `limit`
   * (or the cron cadence) needs raising. Enforcement stays correct (idempotent, eventually consistent);
   * this just makes truncation visible rather than silent.
   */
  readonly capped: boolean;
}

/**
 * The `onTransition` edge-eviction callback the metering cron passes to {@link runCapProducer}: on an
 * org's pause↔resume transition, evict EVERY live endpoint's ingest-token cache entry for that org (the
 * pause flag is per-org, the KV cache is per-endpoint-token-hash — so one org transition must fan out to
 * all its endpoints, or a missed hash leaves a stale principal on that endpoint until the TTL backstop).
 * Extracted here (where the ephemeral-Postgres harness lives) so the fan-out is integration-tested, not
 * just wired inline in the Worker. Reads the token hashes under the org's RLS (webhook_app). Eviction
 * direction-agnostic: pause AND resume both need the cached principal refreshed, so `paused` is unused.
 */
export function makeCapTransitionEvictor(
  app: Sql,
  evict: (tokenHash: Uint8Array) => Promise<void>,
): (orgId: string) => Promise<void> {
  return async (orgId) => {
    const hashes = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ ingest_token_hash: Uint8Array }[]>`
          select ingest_token_hash from endpoints where deleted_at is null`,
    );
    await Promise.all(hashes.map((h) => evict(h.ingest_token_hash)));
  };
}

export async function runCapProducer(deps: CapProducerDeps): Promise<CapProducerResult> {
  const period = currentBillingPeriod(deps.now);

  // Enumerate orgs that could need a transition: usage this period (may cross the cap), OR an active
  // pause (may need to RESUME even with no usage row this period), OR an explicit org_limits row.
  //
  // Ordering: `random()`. A staleness-aware order (least-recently-transitioned first, the tighter
  // worst-case bound) would need `order by ingest_paused.updated_at`, but the least-privilege meter
  // grant (migration 0042) exposes only (org_id, paused) on ingest_paused — no `updated_at` — so that
  // ordering isn't available without widening the grant. `random()` is the right choice among what's
  // grantable: unlike a fixed `order by org_id` (which would permanently starve every org past position
  // `limit`), random gives every candidate an equal per-pass chance, so expected pause latency stays
  // bounded and no org is starved forever. When the candidate set exceeds `limit`, `capped` is returned
  // true so a persistently-truncated producer is visible (raise `limit` / cadence, or grant updated_at
  // for a deterministic bound). At current scale the set is far below `limit`, so this is moot in practice.
  const rows = await deps.meter<Array<{ org_id: string }>>`
    select org_id from (
      select org_id from usage where window_start >= ${period.start}
      union
      select org_id from ingest_paused where paused = true
      union
      select org_id from org_limits
    ) t
    order by random()
    limit ${deps.limit}`;
  const orgIds = rows.map((r) => r.org_id);
  const capped = orgIds.length >= deps.limit;

  let pausedTransitions = 0;
  let resumedTransitions = 0;
  let orgsFailed = 0;
  const transitions: Array<{ orgId: string; paused: boolean }> = [];

  for (const orgId of orgIds) {
    try {
      const desired = await withTenant(deps.app, orgId, async (tx): Promise<boolean | null> => {
        const [usageRow] = await tx<{ events: string }[]>`
          select coalesce(sum(event_count), 0)::bigint as events
          from usage where window_start >= ${period.start}`;
        const [limits] = await tx<{ event_cap: string | null; pause_policy: PausePolicy }[]>`
          select event_cap, pause_policy from org_limits`;
        const [pauseRow] = await tx<{ paused: boolean }[]>`select paused from ingest_paused`;

        const periodUsage = Number(usageRow?.events ?? 0);
        // No org_limits row → Free default (injected); a row → its own cap/policy (event_cap null = uncapped).
        const eventCap = limits
          ? limits.event_cap != null
            ? Number(limits.event_cap)
            : null
          : deps.defaultEventCap;
        const pausePolicy: PausePolicy = limits ? limits.pause_policy : "pause";

        const want = shouldPauseForCap(periodUsage, eventCap, pausePolicy);
        const current = pauseRow?.paused ?? false;
        if (want === current) return null; // no transition

        const since = want ? new Date(deps.now).toISOString() : null;
        const reason = want ? "cap" : null;
        await tx`
          insert into ingest_paused (org_id, paused, reason, since, updated_at)
          values (${orgId}, ${want}, ${reason}, ${since}, now())
          on conflict (org_id) do update
            set paused = ${want}, reason = ${reason}, since = ${since}, updated_at = now()`;
        return want;
      });

      if (desired !== null) {
        transitions.push({ orgId, paused: desired });
        if (desired) pausedTransitions += 1;
        else resumedTransitions += 1;
      }
    } catch (err) {
      orgsFailed += 1;
      deps.log?.("metering.cap.org_failed", { orgId, error: String(err) });
    }
  }

  // Edge eviction runs AFTER the durable writes commit — a stale positive principal must not linger
  // (resume-lag = a paying-customer outage). Best-effort + per-org isolated; the TTL is the backstop.
  if (deps.onTransition) {
    for (const { orgId, paused } of transitions) {
      try {
        await deps.onTransition(orgId, paused);
      } catch (err) {
        deps.log?.("metering.cap.evict_failed", { orgId, error: String(err) });
      }
    }
  }

  return {
    orgsProcessed: orgIds.length,
    pausedTransitions,
    resumedTransitions,
    orgsFailed,
    capped,
  };
}
