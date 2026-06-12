# ADR 0008 — api-key table RLS posture (deferred to the auth workstream)

- status: proposed (deferred — decide during the auth workstream)
- date: 2026-06-12
- scope: `packages/db` (identity migration), `apps/auth`
- supersedes/relates: ADR-0003 (ingest tokens random + hashed), internal ADR-0010 (auth via Better Auth)

## context

better-auth owns identity **and** api keys (internal ADR-0010). The freeze checked in the
generated identity schema as migration
[`0001_better_auth_identity.sql`](../../packages/db/db/migrations/0001_better_auth_identity.sql):
`user` / `session` / `account` / `verification` (core) plus `apikey` (the
`@better-auth/api-key` plugin). These identity tables are **global**, not org-scoped, and are
therefore an explicit, documented **exemption** from the per-org `FORCE ROW LEVEL SECURITY`
that every tenant table carries — the M3 catalog-coverage test lists them as known exemptions.

The `apikey` table is keyed by `referenceId` (the org id) but is managed by the plugin, not by
our tenant-scoped data layer. So today an api key's tenant scoping is enforced by application
logic and the plugin, **not** by Postgres RLS.

The better-auth upgrade (PR #10) kept the plugin on the latest better-auth and did **not** change
this posture — it deliberately left the RLS question to this decision. The full analysis lives in
`build-plans/better-auth-apikey-research.md` in the separate internal repo (§4 Option A vs
Option B, §6 open items).

## decision (deferred)

When the auth workstream wires runtime api-key create / verify / list / revoke, it must
**consciously choose** between:

- **Option A — keep better-auth's `apikey` table as a documented RLS exemption (status quo).**
  Zero new runtime code; inherits the plugin's batteries (permissions, refill, rate-limit,
  expiry) and its 1.6.x concurrency/replay hardening; keys are hashed at rest by the plugin
  (`defaultKeyHasher`, sha256). Tenant isolation for keys stays app-/plugin-enforced, outside
  `FORCE RLS`.

- **Option B — own an `api_keys` table under `RLS` + `FORCE`,** mirroring the ingest-token
  discipline (ADR-0003): CSPRNG ≥256-bit secret, `key_hash bytea unique` (never plaintext),
  hash lookup + constant-time compare, plaintext shown once, org-scoped FK, deny-by-default
  per-command policies keyed on the tenant GUC, granted to `webhook_app` only. True tenant
  isolation at the database layer; one hashing/verify discipline across ingest tokens and api
  keys; removes the api-key path's dependency on the plugin. Cost: we re-implement
  correctness-critical auth code (the exact surface 1.6.x just hardened) and diverge from
  ADR-0010's "better-auth owns api keys" — so Option B warrants an ADR-0010 amendment.

This ADR does **not** pick a side; it records that the choice is open and frames it so the auth
workstream decides deliberately rather than by default.

## migration implications

`0001` is merged — never edit it. Option A needs no migration. Option B is a **new forward
migration** that adds `api_keys` (expand); better-auth's `apikey` table is dropped only in a
**later contract migration** once nothing reads it (never in the same release that starts using
`api_keys`), per `data.mdc` expand → contract.

## consequences / revisit trigger

- Revisit when the auth workstream implements runtime api-key verification behind the
  `verifyBearer(token) → AuthContext` seam (internal ADR-0010).
- Whichever way it lands, update the M3 RLS catalog-coverage exemption list accordingly: Option A
  keeps `apikey` listed as an exemption; Option B brings `api_keys` under coverage and removes the
  exemption once `apikey` is dropped.
- The compliance-by-design argument (database-enforced tenant isolation) is the strongest case for
  Option B; the "don't re-implement hardened auth code" argument is the strongest case for A.
