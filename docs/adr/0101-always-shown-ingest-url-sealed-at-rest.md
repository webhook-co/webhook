# ADR 0101 — Always-shown ingest URL: a sealed-at-rest recoverable token + gated reveal

- status: accepted.
- date: 2026-07-05
- note: renumbered from 0099 (collided with the dashboard nav ADR merged as #361; 0100 taken by #362).
- scope: `packages/db` (the sealed ingest-token columns on `endpoints`, migration 0037; the seal-on-create/
  rotate write path; the typed-plaintext wrapper) + `apps/web` / `apps/api` / `apps/mcp` / `packages/cli`
  (the reveal surface, added in the follow-up slice under this ADR) + `apps/engine` (the reveal-unseal
  entrypoint, follow-up slice). S8-remainder. This slice covers the **storage + seal**; the
  `endpoints.revealIngestUrl` capability + the engine unseal entrypoint extend it next under this ADR.
- relates: [0078](0078-inbound-verification-provider-secret-management.md) (the engine-only KMS envelope this
  reuses — the identical `SecretStore` scheme `provider_secrets` / `signing_keys` seal through),
  [0075](0075-endpoint-management.md) / [0076](0076-endpoint-lifecycle-delete-rotate.md) (the endpoint
  lifecycle + the ingest-token mint/rotate this extends; supersedes their show-once storage note),
  [0011](0011-endpoint-token-resolution.md) (the `webhook_authn` column-scoped resolver grant this must NOT
  extend), [0008](0008-credential-hashing.md) (the one-way peppered HMAC the sealed copy sits ALONGSIDE, not
  instead of). Origin: founder decision-0018 (ingest URL always-shown / retrievable, off peer research).

## context

Founder decision-0018 reversed the ingest-URL posture from **show-once** to **always-shown / retrievable**,
to match peer inspection services. The accept-all-verbs + verification-handshake half shipped (ADR-0085/0086);
this half — the retrievable URL — never did (a 2026-07-05 audit found it mis-recorded as shipped). Today
`endpoints` stores only the token's one-way peppered HMAC (`ingest_token_hash`, ADR-0008), so the
`wbhk.my/<token>` URL is unrecoverable after the one-time create/rotate reveal, and the dashboard reads
"shown only once."

The ingest URL is a **bearer credential for ingestion only** — anyone holding it can have events captured,
but authenticity of captured events rides on **signature verification** (ADR-0078), not URL secrecy (a
forged event without the signing secret is stored `verified=false`). Making it retrievable is therefore a
deliberate, bounded posture change: the token is henceforth **recoverable-by-design, with rotation as
containment**, not a high-value secret. The at-rest and reveal designs must keep a DB/RLS-scoped read breach
yielding ciphertext, not live URLs, and must not let the recoverable copy become a decrypt-anything oracle.

## decision

Store a **second, recoverable representation of the same token**, sealed under the engine-only AWS-KMS
envelope, on the `endpoints` row — alongside (never replacing) `ingest_token_hash`.

- **Storage (migration 0037): same-row, nullable.** The six envelope columns (`ingest_token_ciphertext`,
  `_wrapped_dek`, `_kek_ref`, `_enc_nonce`, `_enc_context`, `_envelope_version`) + `ingest_key_id uuid` are
  added to `endpoints`. Same-row because the sealed copy and the hash are two representations of ONE token
  and must move in lockstep; the create INSERT / rotate UPDATE writes them in the SAME statement, so they can
  never diverge. Nullable, no default → a metadata-only add (no rewrite), and every EXISTING row reads NULL =
  "no recoverable copy" (its plaintext is gone; it stays unrecoverable until rotated). `ingest_key_id` is a
  fresh random uuid per mint (its own column, because the sealed copy lives on the endpoint row rather than a
  per-secret row), and is the AAD `keyId` — so the reveal path rebuilds the AAD `{org_id, id, ingest_key_id}`
  from AUTHORITATIVE columns, never from the audit-only `enc_context` jsonb.
- **Seal happens BEFORE the write tx.** create/rotate mint the plaintext (already in the caller's memory — no
  new plaintext exposure vs today), wrap it in a typed blob, and seal via the existing seal-only
  `PROVIDER_SECRET_SEALER` engine RPC (api/mcp/web never hold the KEK), then write the sealed columns in the
  one create/rotate statement. Never hold the rotate `for update` lock across the seal RPC.
- **Fail-open on the COPY, never on the mutation.** No sealer wired, or a seal failure (KMS blip), degrades to
  all-NULL sealed columns — the endpoint is still created/rotated from its hash (the URL just falls back to
  "rotate to reveal"). On rotate the seal result is ALWAYS written (even all-NULL), so a failed reseal
  overwrites the prior seal rather than leaving a STALE one behind the rotated hash (which would reveal a dead
  URL).
- **Cross-kind confusion fails closed at the plaintext layer.** The token is sealed inside a kind-tagged blob
  (`{"kind":"ingest_token","token":…}`, `serializeIngestToken`); the reveal parses it and rejects anything
  that isn't an ingest-token blob. The seal AAD has no kind discriminator, so this typed wrapper is what keeps
  a provider-secret / signing blob from ever being reinterpreted as an ingest token (or vice versa) even if a
  future generic reader slipped in — mirrors the `serializeBraintreePublicKey` / `serializeProviderSecretPlaintext`
  precedent.
- **Hot path unchanged; grant fenced.** The `webhook_authn` ingest resolver holds a COLUMN-scoped SELECT grant
  (ADR-0011), so the new columns are NOT auto-granted to it — the resolver role literally cannot read the
  sealed bytes (deny-by-default), and we deliberately do not extend that grant. The by-hash cold lookup selects
  explicit columns and is untouched. The control plane (`webhook_app`) holds a table-level grant, which covers
  the new columns for the create/rotate writes and the RLS-org-scoped reveal read.

The **reveal** itself — a dedicated `endpoints.revealIngestUrl` capability gated on `endpoints:write`, an
identifier-only engine unseal entrypoint that reads the blob server-side, an audit row per reveal, and the
always-shown dashboard endpoint-detail — lands in the follow-up slice under this ADR. API keys stay one-time
reveal; this is the low-tier ingest URL only.

## consequences

A `wbhk.my` ingest URL becomes retrievable any time for endpoints created/rotated after this ships (existing
endpoints show "rotate to reveal" — their plaintext is one-way-hashed and gone; force-rotating them at
migration is forbidden, as it would 404 already-configured senders). A DB/RLS-scoped read breach yields
ciphertext AAD-bound to `{orgId, endpointId, keyId}`, useless without the engine's KEK — so the at-rest story
is not a regression versus the hash for DB-only theft. Storage adds no new schema for provider_secrets /
signing_keys, no new grant on the resolver role, and no change to the ingest hot path. The recoverable copy is
redundant with `ingest_token_hash` + the one-time create/rotate reveal, so the migration is cleanly reversible.
