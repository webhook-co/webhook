# ADR 0008 — api-key table RLS posture (Option B: first-party table under FORCE RLS)

- status: accepted (Option B)
- date: 2026-06-13
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
this posture — it deliberately left the RLS question to this decision, which now resolves it in
favor of a first-party table (see decision below). The full analysis lives in
`build-plans/better-auth-apikey-research.md` in the separate internal repo (§4 Option A vs
Option B, §6 open items).

## decision

We take **Option B**: api keys become a first-party `api_keys` table under our own
`ROW LEVEL SECURITY` + `FORCE`, rather than staying on better-auth's plugin-managed `apikey`
table. The two options the auth workstream weighed were:

- **Option A — keep better-auth's `apikey` table as a documented RLS exemption (status quo).**
  Zero new runtime code; inherits the plugin's batteries (permissions, refill, rate-limit,
  expiry) and its 1.6.x concurrency/replay hardening; keys are hashed at rest by the plugin
  (`defaultKeyHasher`, sha256). But tenant isolation for keys stays app-/plugin-enforced,
  outside `FORCE RLS` — the one identity surface that *is* org-scoped sitting outside the
  database isolation boundary.

- **Option B (chosen) — own an `api_keys` table under `RLS` + `FORCE`,** mirroring the
  ingest-token discipline (ADR-0003): CSPRNG ≥256-bit secret, `key_hash bytea unique` (never
  plaintext), hash lookup + constant-time compare, plaintext shown once, org-scoped FK,
  deny-by-default per-command policies keyed on the tenant GUC, granted to `webhook_app` only.
  True tenant isolation at the database layer; one hashing/verify discipline across ingest
  tokens and api keys; removes the api-key path's dependency on the plugin. The cost we accept:
  we re-implement correctness-critical auth code (the exact surface 1.6.x just hardened) and
  diverge from ADR-0010's "better-auth owns api keys" — so this decision carries an ADR-0010
  amendment recording that api keys are now first-party.

The compliance-by-design argument — database-enforced tenant isolation for every org-scoped
row, with no surface exempted by application logic — is what tips it to Option B.

## migration implications

`0001` is merged — never edit it. Option B lands as a **new forward migration** that adds
`api_keys` (expand); better-auth's `apikey` table is dropped only in a **later contract
migration** once nothing reads it (never in the same release that starts using `api_keys`),
per `data.mdc` expand → contract. Until that contract migration runs, `apikey` still exists
and stays a documented RLS exemption — `api_keys` comes under coverage on the expand, but the
`apikey` exemption is removed only when the table is dropped, not before.

## consequences / revisit trigger

- The expand migration brings `api_keys` under the M3 RLS catalog-coverage check. The `apikey`
  exemption stays on the known-exemption list until the contract migration drops the table —
  removing it earlier would fail the coverage test against a table that still exists.
- Runtime api-key verification lands behind the `verifyBearer(token) → AuthContext` seam
  (internal ADR-0010), now hitting the first-party `api_keys` table rather than the plugin.
- We accept the cost of re-implementing the create / verify / list / revoke path that better-auth
  1.6.x just hardened; the test suite has to cover that surface to earn the database-enforced
  isolation Option B buys.
