# ADR 0074 — `whk_` secret-scanning auto-revoke webhook + partner registration

- status: **accepted** — the webhook is built + shipped (was a proposed fast-follow to ADR-0073;
  `endpoints.create` (ADR-0075) landed and cleared `apps/api`, so the merge race is gone). The
  format/checksum half (ADR-0073) shipped first; this is the additive response path. The GitHub
  partner **registration** itself is a manual founder step (no API) — see "as built".
- date: 2026-06-25
- scope: `apps/api` (`secret-scanning.ts` + an unauthenticated `POST /secret-scanning/github` raw
  route in `index.ts`) + `revokeApiKeyByPlaintext` in `packages/db` (`api-keys.ts`). No schema change.
- relates: ADR-0073 (the `whk_` checksum + format that makes the prefix registrable), ADR-0008
  (hash-at-rest), the `aae1` auth-audit chain.
- review severity (when built): high — a public, unauthenticated endpoint that can revoke a live
  key. `/code-review` + `/security-review` required.

## context

ADR-0073 gave `whk_` keys a fixed, self-describing shape (`^whk_[0-9A-Za-z]{49}$`) that platform
secret-scanning can recognise. The value of registering the prefix is realised only with a
**verify → auto-revoke** path: when a key leaks to a public repo, the scanner POSTs the match to
us and we revoke it. This ADR records that design so the deferral is explicit and the
adversarial-review findings are not lost. **Registering the prefix without a live revoke path
would advertise the token shape to scanners (adversarial ones included) before we can respond to
a leak — so registration is coupled to this endpoint going live, never shipped ahead of it.**

## decision (to implement in the fast-follow)

A public `POST https://api.webhook.co/secret-scanning/github`, **unauthenticated** — GitHub
carries no bearer; its signature is the authentication. Handled as a raw branch in `apps/api`
**before** the bearer/contract router. Hardened flow (each step is a reviewed requirement):

1. **Cheap guards first, no DB/egress.** A hard body-size cap (→ `413`); read the **raw bytes**
   and verify the signature over *those exact bytes* (never parse-then-restringify); cap the
   token-array length; a per-endpoint rate-limit.
2. **Fail-closed signature gate — DER-aware.** The `Github-Public-Key-Identifier` selects the key
   from a **KV-cached** copy of GitHub's `secret_scanning` public keys. An unknown key-id triggers
   **at most one bounded refresh** per lock window (60s) — so rotation is handled but neither a
   cold-start stampede nor an attacker spamming random key-ids can drive unbounded outbound egress;
   fail-closed (`null` → 401) when the key is absent or the keys are unavailable. (This supersedes
   an earlier "pinned static allowlist" idea, which would have been brittle against GitHub's key
   rotation.) GitHub signs **ASN.1/DER** ECDSA-P256 (`ECDSA-NIST-P256V1-SHA256`); verify DER-aware —
   we use **WebCrypto** after a DER→raw r‖s conversion (native + guaranteed on workerd; `node:crypto`
   EC verify is uncertain there, and WebCrypto's `subtle.verify` accepts only raw r‖s). Build DB
   deps only **after** the signature passes.
3. **Resolve + revoke (idempotent).** For each token: `verifyKeyChecksum` first — on failure,
   label it and stop (definitively not ours). On success, a new `packages/db`
   `revokeApiKeyByPlaintext` modeled on `findApiKeyGrant`: a **cross-org org-discovery-by-hash**
   as `webhook_authn` (loop the pepper candidates → `{orgId, keyId}`, do **not** filter revoked,
   so a re-report is a no-op), then `withTenant(orgId)` → the audited `revokeApiKey` (`aae1`
   `key_revoked` row, `revokedBy: null`, reason `secret_scanning:github`) → `invalidateHash` KV
   evict. **Idempotent revoke is the replay defense** (GitHub's payload has no nonce; a replayed
   body just re-revokes a dead key). Emit an **out-of-band alert** on every secret-scanning
   revoke.
4. **Respond** per-token `{token_raw|token_hash, token_type, label}`: `true_positive` for any
   checksum-passing token (it *is* one of ours — revoking is a side-effect, not the label
   criterion), `false_positive` **only** on a checksum failure.

**Partner registration** (manual / invite-only). Packet: a human-readable name, the regex
`^whk_[0-9A-Za-z]{49}$`, the live endpoint URL, a **test account** the program can exercise, a
contact, and acknowledgement of the **Secret Scanning Partner Program Agreement** (an org/legal
commitment — founder sign-off, submitted by the founder, not automatically). The endpoint must be
live before submission (it is validated during onboarding).

### notes

- The checksum is the per-endpoint cheap false-positive filter; the registration's
  false-positive reducer is the precise regex. The program is one-directional (GitHub POSTs
  matches → we revoke + label) — there is no partner-hosted validity endpoint to expose.
- RFC 8959 `secret-token:` URI: declined (see ADR-0073) — the prefix already identifies the token.
- The true/false-positive response is a live-key signal, but it is gated behind the signature
  (only the program can elicit it) and revoke is idempotent; documented, not mitigated further.

## consequences

- Closes the "leaked key is scannable but not auto-revoked" gap — registration ships *with* the
  response path, never before it.
- Reuses existing revoke + audit + cache-evict primitives; the only genuinely new code is the
  by-plaintext cross-org lookup and the signed-webhook handler.

## as built

- **Signature verify** is WebCrypto (`crypto.subtle`) after a DER→raw r‖s conversion — NOT
  `node:crypto` sign/verify (its EC-key support on workerd is uncertain; WebCrypto is native).
  Unit-tested with a self-generated P-256 key signing in DER (`node:crypto`), which is exactly
  GitHub's encoding. Public keys are fetched from `…/meta/public_keys/secret_scanning` and
  **KV-cached** (`KV_AUTHZ`, hourly TTL) with a **60s bounded refresh** on an unknown key-id, so
  rotation is handled without unbounded attacker-triggered egress.
- The handler does the cheap guards (256 KiB body cap, 200-token array cap, key-id, signature)
  **before** opening any DB client, and skips the DB entirely when no reported token passes the
  checksum. `revokeApiKeyByPlaintext` discovers the org as `webhook_authn` (it can read only the
  granted columns — `id` is resolved later under `webhook_app`), then revokes + audits
  (`key_revoked`, `source: github_secret_scanning`) under the org's RLS context, and the handler
  evicts `KV_AUTHZ` by hash. A revoke logs `secret_scanning.key_revoked` (the out-of-band alert).
- **Registration is the remaining MANUAL step** — there is no GitHub API for the partner program;
  an org-authorized contact emails `secret-scanning@github.com` with the name/regex/endpoint/test
  token and accepts the Partner Program Agreement (the packet is prepared for the founder). The
  endpoint is live, so GitHub can validate it during onboarding. Until registration completes, the
  endpoint simply receives no traffic — shipping it early is safe (it advertises nothing).
