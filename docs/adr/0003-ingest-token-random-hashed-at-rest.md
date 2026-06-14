# ADR 0003 — ingest tokens are random and stored hashed

- status: accepted
- date: 2026-06-12
- scope: `packages/db`, `apps/engine` (ingest path)
- review severity: high

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
ingest Worker's concern; this decision fixes the column, the unique index, and the
hashing rule.

## consequences

- A leaked database/backup/cache yields hashes, not usable tokens.
- Rotation = issue a new random token, replace the stored hash; the old hash stops
  resolving immediately.
- Recorded in `docs/threat-model.md` (the unauthenticated ingest boundary and the
  `ingest_token` data class). Schema lives in migration `0003_domain_tables.sql`.

## amendment (2026-06-14) — hash is the shared keyed primitive (HMAC-SHA256 + pepper), not a bare sha256

The "stores only the `sha256`" line above is superseded: the ingest token now uses the **same
keyed-HMAC credential primitive as API keys** (ADR 0008 hashing posture). `ingest_token_hash` stores
**`HMAC-SHA256(pepper, token)`** — the pepper held **outside the database** (a Worker/KMS secret,
never a column) — minted by the shared `mintCredential` / `CredentialHasher`. Two reasons:

- **One discipline, one resolver.** Ingest tokens and API keys share `mintCredential` and the
  `createCredentialResolver` hot-KV/cold-DB path, so there is a single hashing-and-verify surface to
  get right (and rotation via current+previous peppers works identically for both).
- **A database-only leak is inert.** A bare `sha256` is matchable against a *known* token from a
  leaked dump; a peppered HMAC is not, without also stealing the out-of-DB pepper. For a 256-bit
  CSPRNG token the keyspace is already unbruteforcible, so peppering is strictly additive
  defense-in-depth — the same argument and custody as the ADR-0004 audit-chain key.

The `bytea, unique` column and hash-lookup rule are unchanged (both digests are 32 bytes). The
migration `0003`/`0009` comments that still say "fast sha256" are stale relative to the shipped code
(`createApiKey`/`createEndpoint` both mint a peppered HMAC); they are merged migrations and left
unedited, with this amendment as the authority. Cross-org token resolution runs as `webhook_authn`
via migration `0011` (a role-targeted SELECT policy + column grant on `endpoints`).
