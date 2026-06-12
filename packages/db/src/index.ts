// @webhook-co/db — the only package that talks to Postgres.
//
// Owns: the SQL migrations (db/migrations, run via dbmate), the postgres.js client
// wired for Hyperdrive (named prepared statements; a caching-disabled binding for
// tenant reads — C1), the withTenant / single-statement RLS helpers, typed
// repositories, and the RLS leak-test harness. packages/shared stays
// runtime-DB-free; this package depends on it for types, never the reverse.

export const DB_PACKAGE = "@webhook-co/db" as const;

export * from "./constants";
export * from "./env";
export * from "./client";
