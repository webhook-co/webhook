# @webhook-co/db

The only package that talks to Postgres: SQL migrations (dbmate), the postgres.js
client wired for Hyperdrive, the RLS helpers, repositories, and the RLS leak-test
harness. `packages/shared` stays runtime-DB-free; this package depends on it for
types, never the reverse.

## Database environments (local / dev / prod)

The local vs dev vs prod difference is a connection-string/binding swap — the same
data-access code runs everywhere. Prod and dev never share a connection string.

- **Local (per developer):** a throwaway Postgres cluster started by the test
  harness (`test/pg.ts`) via `initdb`/`pg_ctl` — no Docker required. For ad-hoc
  local dev, point `DATABASE_URL` at any local Postgres.
- **Dev/staging (hosted):** a Neon project (free), ideally with Neon branching so
  each PR gets an isolated copy-on-write DB. _Needs the Neon account — provisioned
  when we move past local._
- **Production:** a separate Neon project (region-pinned; ingest compute always-on
  per the plan; an EU project added later for residency).

In Workers, the connection string comes from a Hyperdrive binding, not
`DATABASE_URL`. There are **two** bindings (see `apps/engine/wrangler.jsonc`):

- `HYPERDRIVE_TENANT` — query caching **disabled**; used for **all** tenant-scoped
  reads (Hyperdrive's cache is keyed on SQL+params and is blind to the RLS session
  GUC, so caching tenant rows could cross tenants — review finding C1).
- `HYPERDRIVE_CACHED` — caching on; only for non-tenant, cache-safe lookups.

`wrangler dev` uses each binding's `localConnectionString`, so local dev hits a
local Postgres while dev/prod use Hyperdrive → Neon.

## Migrations (dbmate)

Raw, reversible SQL in `db/migrations/` (`-- migrate:up` / `-- migrate:down`).

```sh
DATABASE_URL=postgres://... pnpm --filter @webhook-co/db migrate:up
DATABASE_URL=postgres://... pnpm --filter @webhook-co/db migrate:down
```

## Tests

The db suite needs a **real** Postgres with real roles (RLS + `FORCE ROW LEVEL
SECURITY` + a non-owner role can't be validated on an in-memory/superuser engine).
It therefore runs in a Node-env Vitest project, **separate from the generic test
gate**:

```sh
pnpm test:db   # from the repo root — runs only @webhook-co/db
```

Locally the harness provisions an ephemeral cluster. CI runs the same suite against
a Postgres service container (added with the RLS leak tests).

## Follow-up needing your account

Creating the Neon **dev** and **prod** projects (and wiring their Hyperdrive
configs) needs the Neon account. It does not block local build/test.
