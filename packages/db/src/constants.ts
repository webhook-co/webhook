// Database identifiers shared by the client, the test harness, and (by literal
// duplication) the SQL migrations. Migrations are raw SQL and can't import these,
// so any change here must be mirrored in db/migrations — covered by the RLS
// catalog tests which assert the live role/policy shape.

/** Session GUC carrying the current tenant for RLS policies (set is_local=true). */
export const TENANT_GUC = "app.current_org" as const;

/**
 * Database roles. The request path connects as a NON-OWNER, non-BYPASSRLS role so
 * RLS is never silently bypassed (table owners bypass RLS by default).
 */
export const DB_ROLES = {
  /** Owns the schema + runs migrations. Never used on the request path. */
  owner: "webhook_owner",
  /** Request-path reads/writes. Non-owner, no BYPASSRLS, RLS-enforced. */
  app: "webhook_app",
  /**
   * Unauthenticated ingest hot path. Non-owner, no BYPASSRLS, RLS-enforced; scoped to
   * events only (INSERT + SELECT — SELECT is required by ON CONFLICT's arbiter).
   */
  ingest: "webhook_ingest",
  /**
   * Bearer-verify path (api-key lookup). Non-owner, no BYPASSRLS, RLS-enforced; holds a
   * SELECT-only policy on api_keys via a column-level grant (key_hash, org_id, scopes,
   * expires_at, revoked_at) — never the display metadata, never any write. A leaked
   * credential enumerates key metadata but cannot forge or use a key (ADR-0008 Option B).
   */
  authn: "webhook_authn",
  /**
   * WORM head-anchor cron (ADR-0004). Non-owner, no BYPASSRLS, RLS-enforced; holds a
   * role-targeted `FOR SELECT TO webhook_anchor USING (true)` policy on audit_log plus a
   * COLUMN-level grant on (org_id, seq, row_hash) only — so it reads per-org chain heads across
   * tenants but never the audit content (actor/action/target), and can't write or forge (the HMAC
   * key lives outside the DB). The cross-org read is RLS-native: FORCE RLS would defeat a
   * SECURITY-DEFINER/owner bypass, and BYPASSRLS is forbidden here.
   */
  anchor: "webhook_anchor",
  /**
   * Better Auth runtime role (Lane C / auth.webhook.co). Non-owner, no BYPASSRLS; manages the
   * GLOBAL identity tables (user/session/account/verification — RLS-exempt per 0001) with
   * table-level DML + schema USAGE, and nothing else: no org-scoped tenant tables (those stay
   * webhook_app's, RLS-enforced) and not the plugin `apikey` table (generator-config-only,
   * ADR-0019 — all runtime keys are first-party api_keys). Password injected out of band.
   */
  auth: "webhook_auth",
  /**
   * Cross-org expiry cron-sweep role (ADR-0055 / migration 0020). Non-owner, no BYPASSRLS; the daily
   * auth. cron prunes EXPIRED rows from auth_refresh_token + auth_session_exchange across ALL orgs. Holds
   * DELETE-ONLY on those two tables (no select/insert/update — it can't read any row data) via a
   * role-targeted `FOR DELETE TO webhook_sweeper USING (expires_at < now())` policy, so even a bare DELETE
   * only ever removes already-expired rows. Complements the on-access per-org sweep (which only touches the
   * consuming org). The cross-org delete is RLS-native: FORCE RLS would defeat a SECURITY-DEFINER/owner
   * bypass, and BYPASSRLS is forbidden here. Password injected out of band.
   */
  sweeper: "webhook_sweeper",
} as const;
