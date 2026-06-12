// Database identifiers shared by the client, the test harness, and (by literal
// duplication) the SQL migrations. Migrations are raw SQL and can't import these,
// so any change here must be mirrored in db/migrations — covered by the RLS
// catalog tests (M3) which assert the live role/policy shape.

/** Session GUC carrying the current tenant for RLS policies (set is_local=true). */
export const TENANT_GUC = "app.current_org" as const;

/**
 * Database roles. The request path connects as a NON-OWNER, non-BYPASSRLS role so
 * RLS is never silently bypassed (table owners bypass RLS by default — ADR-0012).
 */
export const DB_ROLES = {
  /** Owns the schema + runs migrations. Never used on the request path. */
  owner: "webhook_owner",
  /** Request-path reads/writes. Non-owner, no BYPASSRLS, RLS-enforced. */
  app: "webhook_app",
  /** Insert-only fallback for the unauthenticated ingest hot path (benchmark-gated). */
  ingest: "webhook_ingest",
} as const;
