// Opportunistic, org-scoped expiry sweep for the short-lived auth-handle tables (refresh-token 0017,
// session-exchange 0019). Both accumulate expired rows once a handle's lifetime passes; expiry is already
// ENFORCED at consume (`expires_at > now()` in the consume gate), so a lingering expired row is never
// honored — it's just dead weight. Rather than a cross-org cron (which would need a BYPASSRLS or a
// role-targeted-policy cross-org role — explicitly NOT taken; see ADR-0028's rejected alternatives and
// migration 0010), we piggyback on the consume operations that already run under `withTenant(orgId)` as
// webhook_app: after a successful consume, opportunistically DELETE the CURRENT org's already-expired rows.
//
// This is RLS-native — each DELETE runs under that table's existing per-org DELETE policy
// (`org_id = current_org_id()`), so it can only ever touch the consuming org's rows and adds NO new role,
// policy, migration, or attack surface. It is best-effort HOUSEKEEPING, never load-bearing: a sweep failure
// is swallowed + logged so it can never roll back or fail the consume.
//
// KNOWN LIMITATION (acceptable for housekeeping): an org that never consumes again won't get swept, so its
// handful of dead rows linger harmlessly (they're already unusable). A complete sweep for fully-churned
// orgs would need a dedicated cross-org role — deliberately deferred.

import { withTenant, type Sql } from "./client";

/**
 * Best-effort, NON-FATAL opportunistic prune of one org's expired refresh handles, run right after a
 * successful consume. Runs in its OWN transaction (separate from the consume's tx, so it can never affect
 * the consume's atomicity or return value) under `withTenant(orgId)` as webhook_app — the existing
 * org-scoped DELETE policy bounds it to this org. Only `expires_at < now()` rows are removed; valid rows,
 * including a just-consumed (used-but-unexpired) handle that `/revoke` may still need to resolve, are
 * preserved. Any error is logged (no PII — message only) and swallowed; returns the count pruned, or 0 on
 * skip/error.
 */
export async function sweepExpiredRefreshTokens(app: Sql, orgId: string): Promise<number> {
  try {
    const rows = await withTenant(
      app,
      orgId,
      (tx) =>
        tx`delete from auth_refresh_token
             where org_id = current_org_id() and expires_at < now()
           returning 1`,
    );
    return rows.length;
  } catch (err) {
    return logSweepSkipped("auth_refresh_token", err);
  }
}

/**
 * Best-effort, NON-FATAL opportunistic prune of one org's expired session-exchange tickets, run right after
 * a successful redeem. Same shape + guarantees as {@link sweepExpiredRefreshTokens}: own transaction,
 * org-scoped under RLS, only-expired rows, errors swallowed + logged. The 300s-TTL exchange table stays
 * tiny, so this keeps it from accumulating dead tickets between an org's logins.
 */
export async function sweepExpiredSessionExchanges(app: Sql, orgId: string): Promise<number> {
  try {
    const rows = await withTenant(
      app,
      orgId,
      (tx) =>
        tx`delete from auth_session_exchange
             where org_id = current_org_id() and expires_at < now()
           returning 1`,
    );
    return rows.length;
  } catch (err) {
    return logSweepSkipped("auth_session_exchange", err);
  }
}

/**
 * Cross-org expiry sweep for the daily auth. cron (migration 0020, ADR-0055). Unlike the per-org on-access
 * sweeps above, this runs as the **webhook_sweeper** role (the caller passes a sweeper-scoped postgres.js
 * client) — a DELETE-only, non-bypass, control-plane role with a role-targeted `FOR DELETE TO
 * webhook_sweeper USING (expires_at < now())` policy on each table. There is NO `withTenant` and NO tenant
 * GUC: the policy scopes the delete to expired rows ACROSS ALL ORGS, which is exactly what fully-churned /
 * abandoned orgs (never swept on-access) need.
 *
 * Two BARE deletes — deliberately no `where expires_at < now()` clause. The role holds NO SELECT privilege,
 * so it cannot read row data; the policy's USING clause is the only gate and bounds the delete to
 * already-expired rows. postgres.js exposes `.count` (rows affected) on a DELETE result, so we report the
 * exact number pruned per table. No PII is read or logged here — only counts are returned.
 *
 * No try/catch: the scheduled-handler caller wraps this and logs `auth.sweep.cron.error` on failure, so a
 * cron error surfaces (and is observable) rather than being silently swallowed by housekeeping.
 */
export async function pruneAllExpiredAuthTokens(
  sql: Sql,
): Promise<{ refreshTokens: number; sessionExchanges: number }> {
  const r = await sql`delete from auth_refresh_token`;
  const s = await sql`delete from auth_session_exchange`;
  return { refreshTokens: r.count, sessionExchanges: s.count };
}

/** Log a swallowed sweep failure (table + error message only — never row contents or the handle). */
function logSweepSkipped(table: string, err: unknown): number {
  console.warn(
    JSON.stringify({
      message: "auth.sweep.skipped",
      table,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return 0;
}
