# ADR 0083 — Tier-3 verification: JWT, asymmetric, and remote-key-fetch (62 → 76 providers)

- status: accepted.
- date: 2026-06-30.
- scope: `packages/webhooks-spec` (new `jws.ts`, `asymmetric.ts`, `x509.ts`; `bytes.ts` gains
  `sha256`/`crc32`; the bespoke-adapter seam grows the Tier-3 providers) + `apps/engine`
  (`key-fetch.ts` — the SSRF-guarded remote fetch — and the `fetchKey` capability threaded onto the
  ingest verify path). No migration (the `provider` columns are free-form text; the registered "secret"
  is an opaque string — a PEM/JWK key, a webhook id, or a JSON config — exactly like an HMAC secret). No
  new API/contract surface — `ProviderSchema` is registry-derived, so every surface inherits the new
  providers. Shipped across PRs #281–#290 (S2.2 Track A, A0–A4).

## context

ADR-0080's config-driven registry covers every provider that signs with a **shared-secret HMAC** (62
providers). The remaining cryptographically-verifiable providers use schemes the HMAC core cannot
express: **JWT** (a signed token whose claims bind the request), **asymmetric signatures** (the
provider signs with a private key; we verify with its public key), and schemes whose **verification key
is fetched at request time** (a JWKS endpoint or a message-supplied certificate URL). These are the
"Tier-3" set from the verification matrix. Adding them is the difference between "we verify the
HMAC majority" and "we verify essentially everything that signs."

## decision

Add three audited primitives in `webhooks-spec` (still a pure, I/O-free leaf) plus one SSRF-guarded
remote-fetch capability in the engine, and express each provider as a bespoke adapter over them.

### 1. JWS/JWT primitive (`jws.ts`) — an alg-allowlist downgrade gate

`parseCompactJws` splits `header.payload.signature`; the adapter passes a **per-provider allowlist** of
permitted `alg`s and the parse **rejects any other** — closing the classic JWT downgrade/confusion
attacks (`none`, or HS256-signed-with-an-RS256-public-key). HS256/512 verification reuses the audited
constant-time HMAC primitive; RS256/ES256 route through the asymmetric helper. `enforceJwtWindow` checks
freshness (`exp`/`iat` upper bound, `nbf`/`iat` lower bound, NaN-now guarded). Body binding is explicit
per provider: a documented body-hash claim (`payload_hash`, `request_body_sha256`) is **independently
recomputed and compared**, never trusted from the token alone.

### 2. Asymmetric primitive (`asymmetric.ts`, `x509.ts`) — WebCrypto, fail-closed

`verifyEd25519`, `verifyEcdsaP256Sha256`, and `verifyRsaPkcs1Sha256` (SHA-1 and SHA-256) wrap workerd's
`crypto.subtle.verify` over `spki`/`raw`/`jwk` key imports. ECDSA signatures are normalised from DER to
the raw `r‖s` WebCrypto expects (`derEcdsaSigToRaw`, null on malformed). `x509SpkiFromDer` extracts the
SPKI public key from a DER certificate via a **bounds-checked ASN.1 walk confined to the tbsCertificate**
(the remote-fetch providers hand us a cert, not a bare key). Every helper is wrapped try/catch → `false`;
the registered public key (PEM/JWK/base64) is the provider's "secret".

### 3. Remote key/cert fetch (`apps/engine/key-fetch.ts`) — the load-bearing decision

`webhooks-spec` stays pure: the adapter declares **what** to fetch (a `KeyFetchSpec` — `cacheKey`, `url`,
an `allowedHosts` pin, ttl) and the engine injects a `KeyFetcher` that performs it. The fetcher is an
**SSRF chokepoint**: HTTPS-only; the hostname must match the spec's pin (exact-host or an anchored
RegExp — e.g. PayPal's cert host, an SNS `^sns\.<region>\.amazonaws\.com$`, a provider's JWKS host — never
attacker-chosen); `redirect: "error"`; an `AbortController` timeout; a content-length precheck + 64 KiB
cap; an in-isolate TTL cache (bounded to 256 entries, **failures not cached**). Any failure is **fail-soft**
to a typed `KEY_FETCH_FAILED` — the event is still captured `verified:false`, never dropped, and the
durable-before-ACK ACK is never blocked beyond the timeout. Plaid's key endpoint is authenticated (the
registered secret is a `{environment, client_id, secret}` JSON); its `request_body_sha256` claim is bound
**after** signature verification.

### 4. F5 — origin-authenticated providers are honestly weaker

`monday` and `jira_connect` (Atlassian Connect) sign a JWT that authenticates the **request origin** (Jira
via a `qsh` = method+path+query hash; monday via an `aud` claim) but **do not bind the request body**. We
verify the signature and the request binding and report `verified:true`, but record here that this is an
*origin* guarantee, marginally weaker than a body-signature: it proves the sender, not that these exact
bytes weren't substituted by a same-origin actor. The `qsh` canonicaliser sorts raw then encodes, uses a
literal comma (not `%2C`), and the confused-deputy "context-qsh" path is rejected.

## consequences

- **Coverage.** 14 Tier-3 providers now verify (messagebird/netlify/vonage/monday/jira_connect via JWT;
  discord/telnyx/sendgrid/wise via embedded-key asymmetric; kinde/paypal/aws_sns/plaid via remote fetch),
  taking the registry 62 → 76 before the Tier-4 authenticity set (ADR-0082) brought it to 85.
- **A new outbound-fetch surface, deliberately bounded.** Remote key fetch is the one genuinely new piece
  of infrastructure near the ingest hot path. Its safety rests entirely on the host-pin + cache + timeout +
  fail-soft posture above; it was the focus of the adversarial security review on the A4 PRs.
- **Primitives confirmed against published vectors.** Discord, Wise, and SendGrid ship published
  gold-vector tests; the rest use self-consistent KATs built from runtime keypairs (no private keys in the
  repo) plus a build-time re-read of each provider's signing doc.
- **Honest status.** Origin-authenticated providers (F5) are documented as a slightly weaker guarantee than
  a body signature, consistent with this project's "honesty over cleverness" stance on verification.
- **AWS SNS `SubscriptionConfirmation`** is surface-only in v1: we verify the signature but do not auto-GET
  the confirmation URL (a deliberate scoping call to avoid an unsolicited outbound request).
