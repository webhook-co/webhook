# ADR 0007 — isolate secret cache holds non-extractable CryptoKey handles

- status: accepted
- date: 2026-06-12
- scope: `packages/shared` (envelope/KMS seam), KMS workstream
- review id: M7 (refines the compliance-by-architecture ADR, §e — isolate caching)

## context

Signing keys and inbound provider secrets are envelope-encrypted (ciphertext + wrapped
DEK in Postgres, KEK in KMS). The hot path — outbound signing and inbound verification —
needs the *plaintext* secret, so it unwraps once and caches in a size-bounded, org-scoped
LRU in isolate memory rather than calling KMS per event. The open question the review
flagged: cache **what**? Caching raw key bytes leaves extractable secret material
resident in a multi-tenant isolate's heap.

## decision

The cache holds **non-extractable `CryptoKey` handles, never raw key bytes** (M7). The
`KmsProvider.unwrapDek` seam returns a non-extractable AES-GCM `CryptoKey`
(`packages/shared/src/envelope.ts`), and `importDek`/`generateDekKey` default to
`extractable: false`. WebCrypto then performs encrypt/decrypt against an opaque handle;
the plaintext key bytes are never re-exposed to JS once imported. The envelope itself is
AES-256-GCM with a 96-bit nonce and AAD bound to `{org_id, endpoint_id, key_id}`
(`envelope_version` allows format migration); a known-answer test vector locks the
format (M6). BAA tenants default to a tighter or zero cache (unwrap-per-use), keyed off
the tenant's compliance tier.

This refines the compliance-by-architecture decision (ADR-0009 §e on isolate caching):
the cache is process-local, size-bounded, evicted under bound, never persisted, and now
holds handles rather than extractable bytes.

## consequences

- A heap dump of a shared isolate yields opaque key handles, not extractable secrets,
  shrinking the blast radius of the documented "plaintext key material transiently in a
  shared isolate" residual.
- The concrete KMS custodian (AWS KMS) and the LRU implementation are the post-freeze
  KMS workstream; the freeze fixes the seam, the envelope format, and the handle rule.
- Recorded in `docs/threat-model.md` (the shared-isolate secret boundary + residuals).
