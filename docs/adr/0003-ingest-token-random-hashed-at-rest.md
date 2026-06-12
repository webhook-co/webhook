# ADR 0003 — ingest tokens are random and stored hashed

- status: accepted
- date: 2026-06-12
- scope: `packages/db`, `apps/engine` (ingest path)
- review id: H4 (high)

## context

The `wbhk.my/<token>` path token is a bearer capability: whoever holds it can post
events to an endpoint. An earlier sketch used the endpoint's UUIDv7 as the token. Two
problems: UUIDv7 is **time-ordered and partly guessable** (it encodes a timestamp), so
it is unfit as a secret; and storing the usable token in plaintext means a database,
backup, or cache leak hands an attacker working tokens.

## decision

- The token is a **CSPRNG value of at least 256 bits**, generated at endpoint creation
  and **shown to the user exactly once**.
- Postgres stores **only the `sha256` of the token** in `endpoints.ingest_token_hash`
  (`bytea`, unique) — never the plaintext. Lookups are by hash.
- The hot-path resolution caches in KV are keyed by the **hash**, and comparison is by
  the full 32-byte digest (preimage resistance makes the indexed lookup safe; a
  constant-time compare can be applied at the app layer where a raw secret is involved).

Token→org resolution itself (a pre-tenant lookup that can't carry RLS context) is the
phase-1 ingest Worker's concern; the freeze fixes the column, the unique index, and the
hashing rule.

## consequences

- A leaked database/backup/cache yields hashes, not usable tokens.
- Rotation = issue a new random token, replace the stored hash; the old hash stops
  resolving immediately.
- Recorded in `docs/threat-model.md` (the unauthenticated ingest boundary and the
  `ingest_token` data class). Schema lives in migration `0003_domain_tables.sql`.
