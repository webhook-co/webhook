// Database identifiers shared by the client, the test harness, and (by literal
// duplication) the SQL migrations. Migrations are raw SQL and can't import these,
// so any change here must be mirrored in db/migrations — covered by the RLS
// catalog tests (M3) which assert the live role/policy shape.

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
} as const;
