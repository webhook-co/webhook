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
- There is deliberately NO caching binding. One existed (`HYPERDRIVE_CACHED`, "only for non-tenant,
  cache-safe lookups") and was read by zero source files for its entire life, while forcing the cache-posture
  guard to carry a by-name exemption that two review rounds walked a cross-tenant leak straight through. A
  binding nothing reads is not worth a hole in a tenant boundary. The `webhook-prod-cached` Hyperdrive config
  still exists; re-adding the binding means re-adding the guard's exemption, scoped to an (app, binding) pair.

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
CI (`test-db` job) the same suite runs against a `postgres:17` service container with
`POSTGRES_HOST_AUTH_METHOD=trust`; each file creates its own database on the service
for isolation. Set `TEST_DATABASE_URL` to attach to any running Postgres the same way.

**PostgreSQL 17 is required**, in every lane. It is not cosmetic: the harness models the
managed engine's **non-superuser provider role**, which relies on PG16+ role-membership
semantics — on an older server the provider inherits the schema owner and silently regains
every privilege `test/provider-fidelity.test.ts` exists to prove it lacks. The harness finds
a PG17 install even when `initdb` on `PATH` is older (Homebrew links only one major); set
`TEST_PG_BINDIR` to override.

**Auth modes.** The harness auto-detects from `TEST_DATABASE_URL`: no password →
**trust** mode (local cluster / trust-auth CI service); a password (e.g. a Neon URL)
→ **password** mode, where it mints a per-run SCRAM password for **every role in
`DB_ROLES`** (18 of them, derived — never hand-listed, and never written to source) and
uses the URL's `sslmode`. Validate password mode locally against a SCRAM cluster:

```sh
TEST_DATABASE_URL='postgres://postgres:PW@127.0.0.1:5432/postgres?sslmode=disable' \
TEST_DATABASE_EXPECTED_HOST='127.0.0.1' pnpm test:db
```

**Nightly vs a real Neon branch.** `.github/workflows/nightly-rls.yml` runs the same
suite against a real Neon branch (PostgreSQL 17, as both Neon projects are). To enable:
add a branch connection URL (with `sslmode=require`) as the `NEON_TEST_DATABASE_URL`
secret, and that branch's hostname as the `NEON_TEST_DATABASE_HOST` repo **variable**.
The harness creates a fresh database per test file on it. With neither set the workflow
skips cleanly (green). With the secret set but the variable missing it **fails** rather than
skipping — a leak suite that silently stops running is worse than one that goes red.

> ⚠️ **The nightly branch is NOT disposable.** The CI Neon project has exactly one
> branch — `primary`, `default`, no parent — so there is **no `reset_from_parent`
> recovery path** if its cluster-global role state gets wedged. This matters because the
> harness rotates cluster-global role passwords on every run and several migrations'
> down-sections `DROP` those roles. Treat it as shared, precious state: serialize
> everything that touches it, and never point a local run at it while a nightly is in
> flight. (Earlier wording here called it "disposable"; that promised a recovery path
> which does not exist.)

**Target-cluster safety.** Because the harness rotates cluster-global roles and drops
databases, it refuses to run against a managed/TLS Postgres unless
`TEST_DATABASE_EXPECTED_HOST` names that exact host (`test/expected-host.ts`). Unset ⇒
refuse, rather than defaulting to "allow". The local ephemeral cluster and the trust-auth
CI service are unaffected. `scripts/remote-db-test-guard.mjs` (R6) pins the assertion's
position ahead of the first destructive statement, and pins that turbo forwards the
variable — Turbo runs in strict env mode, so an unforwarded variable would make every
remote run fail closed.

## Follow-up needing your account

Creating the Neon **dev** and **prod** projects (and wiring their Hyperdrive
configs) needs the Neon account. It does not block local build/test.
