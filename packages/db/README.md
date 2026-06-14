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
- **Production:** a separate Neon project (region-pinned; ingest compute always-on;
  an EU project added later for residency).

In Workers, the connection string comes from a Hyperdrive binding, not
`DATABASE_URL`. There are **two** bindings (see `apps/engine/wrangler.jsonc`):

- `HYPERDRIVE_TENANT` — query caching **disabled**; used for **all** tenant-scoped
  reads (Hyperdrive's cache is keyed on SQL+params and is blind to the RLS session
  GUC, so caching tenant rows could cross tenants).
- `HYPERDRIVE_CACHED` — caching on; only for non-tenant, cache-safe lookups.

`wrangler dev` uses each binding's `localConnectionString`, so local dev hits a
local Postgres while dev/prod use Hyperdrive → Neon.

## Migrations (dbmate)

Raw, reversible SQL in `db/migrations/` (`-- migrate:up` / `-- migrate:down`).

```sh
DATABASE_URL=postgres://... pnpm --filter @webhook-co/db migrate:up
DATABASE_URL=postgres://... pnpm --filter @webhook-co/db migrate:down
```

The migrations:

1. `0001_better_auth_identity` — the pinned, generated Better Auth schema
   (`user`/`session`/`account`/`verification`/`apikey`). Global identity, **exempt**
   from per-org RLS (the auth layer owns any later scoping).
2. `0002_extensions_and_app_roles` — `citext`; the non-owner `webhook_app` and
   `webhook_ingest` roles (idempotent; no passwords — credentials are injected out of
   band, trust auth locally/CI).
3. `0003_domain_tables` — `orgs … delivery_attempts`, indexes (incl. the tunnel index
   `events(endpoint_id, received_at, id)` and unique `(endpoint_id, dedup_key)`),
   RLS + `FORCE` + per-command policies, grants, and the server-stamped `received_at`
   trigger.
4. `0004_metering` — `usage` / `org_limits` / `ingest_paused` (single-dimension,
   no prices).
5. `0005_audit_log` — append-only, per-org HMAC-chained audit log: contiguous-seq +
   prev-hash trigger and an immutability (no UPDATE/DELETE/TRUNCATE) trigger.
6. `0006_ingest_event` — the single-statement `ingest_event()` (`SECURITY INVOKER`,
   `set_config(local)`, `ON CONFLICT DO NOTHING`) and the ingest-role
   `statement_timeout` that bounds the tunnel watermark.

The non-owner ownership model is load-bearing: migrations run as a **non-superuser**
`webhook_owner` that owns the schema, so `FORCE ROW LEVEL SECURITY` actually polices
the owner and the leak suite's owner-bypass negative control is meaningful.

`.better-auth.schema.sql` is the generator's raw output, kept for diffing on
regenerate (`pnpm --filter @webhook-co/auth run auth:generate`); it is **not** a
dbmate migration.

## Tests

The db suite needs a **real** Postgres with real roles (RLS + `FORCE ROW LEVEL
SECURITY` + a non-owner role can't be validated on an in-memory/superuser engine).
It therefore runs in a Node-env Vitest project, **separate from the generic test
gate**:

```sh
pnpm test:db   # from the repo root — runs only @webhook-co/db
```

It covers: cross-org isolation on every tenant table; deny-by-default with no
context; pooled-connection no-leak; the owner/`FORCE RLS` negative control;
catalog-driven RLS coverage (every non-exempt table has RLS+FORCE+4 policies, app
roles are non-owner/non-superuser/no-BYPASSRLS); no unexpected `SECURITY DEFINER`
routines; `ingest_event()` dedup + server-stamped `received_at`; the audit chain +
immutability; and migration up→down→up reversibility.

Locally the harness provisions an ephemeral cluster per test file (`test/pg.ts`). In
CI (`test-db` job) the same suite runs against a `postgres:14` service container with
`POSTGRES_HOST_AUTH_METHOD=trust`; each file creates its own database on the service
for isolation. Set `TEST_DATABASE_URL` to attach to any running Postgres the same way.

**Auth modes.** The harness auto-detects from `TEST_DATABASE_URL`: no password →
**trust** mode (local cluster / trust-auth CI service); a password (e.g. a Neon URL)
→ **password** mode, where it mints per-run SCRAM passwords for the
`webhook_owner`/`webhook_app`/`webhook_ingest` roles (never written to source) and uses
the URL's `sslmode`. Validate password mode locally against a SCRAM cluster:

```sh
TEST_DATABASE_URL='postgres://postgres:PW@127.0.0.1:5432/postgres?sslmode=disable' pnpm test:db
```

**Nightly vs a real Neon branch.** `.github/workflows/nightly-rls.yml` runs the
same suite against a real Neon branch (PG 15+ can differ from local PG 14 in role/RLS
behavior). To enable: provision a disposable Neon **branch** and add its connection URL
(with `sslmode=require`) as the `NEON_TEST_DATABASE_URL` secret. The harness creates a
fresh database per test file on it. Until the secret exists the workflow skips cleanly.

> Neon specifics to confirm on the first run (PG 15+ / managed, not validated locally):
> the provider role can `alter schema public owner` (or fall back to `grant create on
> schema public`), a `CREATEROLE` non-superuser can create the app/ingest roles, and
> `createClient`/dbmate honor `sslmode=require`. The owner/superuser negative control
> runs as Neon's (non-superuser) owner role — the immutability trigger still blocks it.

## Follow-up needing your account

Creating the Neon **dev** and **prod** projects (and wiring their Hyperdrive
configs) needs the Neon account. It does not block local build/test.
