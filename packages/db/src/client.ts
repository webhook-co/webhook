import postgres from "postgres";

import { TENANT_GUC, USER_GUC } from "./constants";

export interface ClientOptions {
  /** Pool size. Keep small in Workers; Hyperdrive pools upstream. */
  max?: number;
}

/**
 * Create a postgres.js client.
 *
 * `prepare: true` uses named prepared statements (supported by Hyperdrive in
 * transaction-mode pooling, and faster on the hot path); `fetch_types: false`
 * drops a startup round-trip (Cloudflare's recommended setting). Create the client
 * inside the request handler in Workers — never at module/global scope.
 *
 * IMPORTANT (review finding): for tenant-scoped reads the caller MUST pass the
 * connection string from the CACHE-DISABLED Hyperdrive binding (HYPERDRIVE_TENANT).
 * Hyperdrive query caching is keyed on SQL+params and is blind to the RLS session
 * GUC, so a cached tenant query can serve one org's rows to another. This factory
 * can't see the binding choice, so the discipline is enforced at the call sites and
 * the wrangler config, not here.
 */
export function createClient(connectionString: string, options: ClientOptions = {}) {
  return postgres(connectionString, {
    prepare: true,
    fetch_types: false,
    max: options.max ?? 10,
  });
}

export type Sql = ReturnType<typeof createClient>;

// The transaction-scoped client, with the same custom-types parameter as Sql
// (inferred, so there is no literal `{}` for eslint to reject).
type SqlTypes = Sql extends postgres.Sql<infer U> ? U : never;
export type TenantTx = postgres.TransactionSql<SqlTypes>;

/**
 * Run `fn` with the tenant RLS context set. Sets `app.current_org` with
 * is_local=true inside a transaction so it is scoped to the transaction and
 * auto-reset on a pooled connection's return — the safe general form for
 * authenticated multi-query read requests (api./app.).
 *
 * The unauthenticated ingest hot path does NOT use this — it uses the
 * single-statement `SELECT ingest_event(...)` (one implicit transaction, no
 * connection pinning), per the migrations.
 */
export async function withTenant<T>(
  sql: Sql,
  orgId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config(${TENANT_GUC}, ${orgId}, true)`;
    return fn(tx);
  });
  return result as T;
}

/**
 * Run `fn` with the USER RLS context set (`app.current_user`, is_local — same discipline as withTenant).
 * This is the context for the one question the tenant-scoped policies structurally cannot answer: "which
 * orgs do I belong to?" (migration 0067). It sets NO tenant GUC, deliberately — the caller is choosing an
 * org, so it cannot already have one.
 *
 * Everything reachable from here is gated on `user_id = current_app_user()`, so it can only ever see the
 * caller's OWN memberships and the orgs those point at. `userId` MUST come from the verified session,
 * never from client input — it is the whole authorization boundary of this context.
 */
export async function withUser<T>(
  sql: Sql,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config(${USER_GUC}, ${userId}, true)`;
    return fn(tx);
  });
  return result as T;
}
