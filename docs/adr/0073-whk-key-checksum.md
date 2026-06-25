# ADR 0073 — self-describing checksum for `whk_` API keys

- status: accepted.
- date: 2026-06-25
- scope: server — `packages/db`: a new `key-checksum.ts` (CRC32 + base62 + `verifyKeyChecksum`),
  `mintChecksummedCredential` in `credential.ts`, `insertApiKey` switched to it (the single mint
  chokepoint for every `whk_` key), and an opt-in `precheck` on `createCredentialResolver` wired
  by `auth-deps` (the api / engine / mcp seam). No new dependency; no schema change.
- relates: ADR-0003 (256-bit credential floor), ADR-0008 (hash-at-rest, plaintext-shown-once),
  ADR-0019 (every runtime key is a first-party `api_keys` row). The `whk_` prefix
  secret-scanning auto-revoke webhook + partner registration is ADR-0074.
- review severity: medium (a breaking credential-format change). `/code-review` +
  `/security-review`.

## context

`whk_` API keys were minted as `whk_` + `base64url(32 random bytes)` — full entropy, hashed at
rest, but with **no self-describing structure**. Two long-planned niceties never shipped: a
checksum (so a truncated / typo'd / corrupted key is rejected cheaply, client-side and at the
edge, before any database lookup) and a format that platform secret-scanning can recognise.

Adding either changes the token's structure, which is a **breaking migration once keys exist in
the wild** — you must re-issue every live key or carry dual-format parsing forever. The window
to do it cheaply is now: there is a single live key, before GA and before self-serve key
creation. Deciding later only gets more expensive.

## decision

A minted `whk_` key is:

```
whk_<43 base62 chars: 256-bit CSPRNG body><6 base62 chars: CRC32 of the body>
```

— a fixed **53-char** token matching `^whk_[0-9A-Za-z]{49}$`.

1. **base62 body, 256-bit entropy.** The body is a fixed-width base62 rendering of one
   256-bit CSPRNG draw (the same entropy floor as before; ADR-0003), left-padded to exactly 43
   chars. base62 (no `-`/`_`) gives a clean secret-scanning regex and double-click/shell-safe
   selection. 43 is the tight minimum (`62^42 < 2^256 < 62^43`); the left-pad makes every key
   exactly 43 body chars (the rendering is a uniform bijection — no modulo bias, no
   leading-zero truncation).

2. **6-char base62 CRC32 checksum, inside the hashed plaintext.** The checksum is `CRC32` of
   the body string, base62-encoded and zero-padded to 6 chars (`62^5 < 2^32 < 62^6`). It is part
   of the plaintext, so the stored `key_hash = HMAC-SHA256(pepper, full plaintext)` covers it and
   at-rest storage / verification are unchanged. **The checksum is NOT a security control** —
   CRC32 is public, trivially forgeable error-detection. Token security rests entirely on the
   256-bit secret and the peppered hash-at-rest (ADR-0008); the checksum only catches accidental
   corruption and lets a scanner recognise the prefix.

3. **Edge guard.** `verifyKeyChecksum` runs as an opt-in `precheck` at the front of the shared
   credential resolver (before hashing / cache / database), wired only on the api-key path. A
   malformed key is rejected with the same response as an unknown key. It is opt-in because the
   same resolver also serves ingest tokens, which keep their own format — `mintCredential` (and
   therefore `whep_` ingest tokens) is left untouched.

4. **Hard cut, not dual-parse.** With one live key, the single key is re-minted to the new format
   and the old one revoked, rather than teaching the system to accept both formats indefinitely.

### alternatives considered

- **Do nothing / keep the format (ADR-0017 path ii).** Rejected: the change is near-free now and
  unboundedly more expensive after GA; a self-validating, scannable format is worth having.
- **Dual-parse both formats forever.** Rejected: permanent complexity to serve a population of
  one. A one-time re-mint is cheaper and cleaner.
- **Keep the base64url body and only append a checksum.** Rejected: base64url's `-`/`_` make a
  noisier scanning regex and worse selection/copy ergonomics; base62 is the small extra step that
  buys a clean, registrable shape.
- **RFC 8959 `secret-token:` URI.** Rejected: the `whk_` prefix already gives identifiability;
  the URI scheme adds friction for no gain here.

## consequences

- Old-format keys stop authenticating once the edge guard enforces; the single live key is
  re-minted first (a calm, both-formats-valid window), so no holder is stranded.
- The format is now registrable with secret-scanning programs; the verify→auto-revoke webhook and
  registration are tracked separately (ADR-0074).
- Every `whk_` minter (dashboard, OAuth grant, device) funnels through `insertApiKey`, so all
  pick up the new format from one change; ingest `whep_` tokens are deliberately unaffected.
