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
