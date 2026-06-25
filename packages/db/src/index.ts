// @webhook-co/db — the only package that talks to Postgres.
//
// Owns: the SQL migrations (db/migrations, run via dbmate), the postgres.js client
// wired for Hyperdrive (named prepared statements; a caching-disabled binding for
// tenant reads), the withTenant / single-statement RLS helpers, typed
// repositories, and the RLS leak-test harness. packages/shared stays
// runtime-DB-free; this package depends on it for types, never the reverse.

export const DB_PACKAGE = "@webhook-co/db" as const;

export * from "./constants";
export * from "./env";
export * from "./client";
export * from "./orgs";
export * from "./endpoints";
export * from "./audit-append";
export * from "./auth-audit";
export * from "./auto-approve";
export * from "./grants";
export * from "./refresh-token";
export * from "./session-exchange";
export * from "./sweep";
export * from "./auth-user";
export * from "./credential";
export * from "./key-checksum";
export * from "./credential-cache";
export * from "./credential-resolver";
export * from "./ingest-resolver";
export * from "./ingest-event";
export * from "./provider-secrets";
export * from "./api-keys";
export * from "./verify-bearer";
export * from "./auth-deps";
export * from "./reads";
export * from "./read-handlers";
export * from "./replay";
