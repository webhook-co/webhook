// @webhook-co/db — the only package that talks to Postgres.
//
// It owns: the SQL migrations (db/migrations, run via dbmate), the postgres.js
// client wired for Hyperdrive (named prepared statements, caching-disabled
// binding for tenant reads), the `withTenant` / single-statement RLS helper,
// typed repositories, and the RLS leak-test harness. `packages/shared` stays
// runtime-DB-free; this package depends on it for types, never the reverse.
//
// Real implementations land in the schema-migrations and db-environments steps.
export const DB_PACKAGE = "@webhook-co/db" as const;
