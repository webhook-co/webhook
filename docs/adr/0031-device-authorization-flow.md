# ADR 0031 — the RFC 8628 device authorization flow: a KV-backed device-code store

- status: accepted (**A4a** — the device-code store over KV; **A4b** — the `/device_authorization` endpoint +
  the `/token` device grant, see the A4b note at the end; **A4c** (next) adds the `/device` verify→consent
  integration). The CLI-facing device protocol serves over HTTP; approval lands in A4c.
- date: 2026-06-21
- scope: `apps/auth/src/issuer/device-store.ts` (+ tests).
- relates: ADR-0024 (Option-B issuance — the device grant mints directly, like refresh, no provider code),
  ADR-0028 (the refresh-token store — the single-use pattern this echoes, and the org-embedded-handle trick
  that does NOT apply here), ADR-0030 (the consent flow + `ConsentProps` the device approval reuses),
  ADR-0029 (the wrangler-layer issuer routes A4b's endpoints will mount under), `internal/build-plans/
  lane-c-auth-identity-backend.md` §2 (A4).
- review severity: high (the device single-use property; a security review folded).

## context

Headless/SSH login needs RFC 8628 (the device authorization grant): the CLI gets a `device_code` +
`user_code`, the user approves on a browser at `/device`, and the CLI polls for the token.
`@cloudflare/workers-oauth-provider` implements only `authorization_code` + `refresh_token` (verified in its
token router) — **no device grant** — so Lane C owns the whole flow, minting directly via `mintScopedKey`
(as the refresh path does), never through a provider code.

The defining constraint: a `device_code` is created at `/device_authorization` **before any user signs in**,
so it has **no org/user** until approval. That rules out the tenant-RLS DB tables the rest of the system
uses — the org-embedded-handle trick that backs the refresh store (ADR-0028) needs an org at creation, and a
cross-org write role is exactly what ADR-0028 avoided. So device-code state lives in **KV**.

## decision

**1. Device codes live in KV (`device-store.ts`), keyed by hashes.** Two entries per code: the record under
`dc:<sha256(device_code)>` and an index `uc:<sha256(user_code)>` → the dc-key, so the verify path (which has
the user code) and the poll path (which has the device code) resolve the same record. Both codes are hashed
into the keys, so a KV listing never yields a usable code. The `device_code` is 256-bit CSPRNG; the
`user_code` is 8 chars from an unambiguous alphabet (no O/0/I/1/L) in Lane E's canonical `XXXX-XXXX` form.
KV's TTL gives expiry; `expiresAt` on the record is the authority (checked independently of the KV TTL).

**2. Single-use via delete-on-read.** KV is not transactional, so the FSM claims single-use by deleting both
keys when a poll reads an `approved`/`denied` record. This is a deliberate trade — **strict single-use over
retry**: if the caller's mint fails after the poll consumed the code, the approval is lost and the user
re-approves, rather than leaving the code live (which would risk over-issuance). The expected client is a
single sequential interval-gated poller, so the concurrent-double-read window doesn't arise in practice;
A4b adds poll-rate limiting. The minted keys are scoped, audited, and revocable regardless.

**3. The FSM** (`pollDeviceCode`): `pending` → `slow_down` (a poll before `notBefore`, which each poll bumps
by the interval) → `approved` (returns the recorded `ConsentProps` for the caller to mint) / `denied` /
`invalid` (unknown/expired). Approval is recorded by `setDeviceDecision` (the device's consent decision),
which stamps the org/user/scopes/audience/device onto the record — the same `ConsentProps` the PKCE consent
records, so the device flow reuses the consent screen + the mint path unchanged.

**4. User-code input is normalized** (uppercase, strip separators) before hashing (RFC 8628 §6.1), matching
Lane E's client-side normalize, so a code typed `abcd 2345` resolves the same record.

## rejected alternatives

- **A DB table for device codes** — a device code has no org at creation, so it can't be tenant-RLS-read on
  the (org-less) poll path; a non-RLS cross-org write role for the issuer is the broad capability ADR-0028
  rejected. KV sidesteps both and fits the short-lived high-churn poll.
- **Storing raw codes as KV keys** — a KV listing would leak usable codes; hashing the keys prevents that.
- **HMAC+pepper for the code hashes** — unnecessary: the `device_code` is 256-bit (an unkeyed hash leaks
  nothing), and the low-entropy `user_code`'s real protection is rate-limiting + a short TTL (A4b), not hash
  strength — an HMAC wouldn't stop online guessing.

## consequences — A4b (next) MUST handle

- **The endpoints:** `POST /device_authorization` (validate client + scopes ∩ capability + resource, mint a
  code, RFC 8628 response with `verification_uri`/`verification_uri_complete`); the `/token` device grant
  (`grant_type=urn:ietf:params:oauth:grant-type:device_code` → `pollDeviceCode` → mint on approved, mapping
  the FSM to `authorization_pending`/`slow_down`/`expired_token`/`access_denied`); the `/device` verify →
  consent integration (resolve the user code → reuse the consent screen → `setDeviceDecision`).
- **Verify-path rate-limit + auth-gate (security, must-before-live):** the `user_code` is ~40 bits, so the
  verify path (`findByUserCode`/`setDeviceDecision`) is online-guessable. A4b must (a) require an
  authenticated session before approval is reachable (so a guessed code can only be approved into the
  attacker's OWN org — limiting impact to denial/phishing of a victim's in-flight code, not cross-org mint),
  and (b) add a durable global guess-rate limit (dovetails with the deferred magic-link rate-limiting).
- **Real CSPRNG wiring:** the injected `randomBytes` MUST be `crypto.getRandomValues` in the deps builder.
- **A new `DEVICE_KV` binding** in `wrangler.jsonc` (provisioned in the deploy slice).
- **KV 60s-min-TTL:** near-expiry re-writes are skipped (`putRecord` guards `< 60s`); A4b integration-tests
  against real KV.

## test posture

The store is fully unit-tested (13 tests) against an in-memory fake KV: create (two keys, canonical user
code, no ambiguous chars), find (unknown/expired/normalized-input), decision (approve props / deny /
not-found / already-decided), and the full poll FSM (pending / slow_down / approved+single-use / denied /
invalid). The endpoints + the real KV/RNG wiring are A4b (glue → build:cf/deploy:dry + integration).

## A4b — the CLI-facing device endpoints (DONE, this slice)

A4b makes the CLI side of the device flow serve over HTTP (the browser approval is A4c). The device flow is
fully Lane C — the provider has no device grant — so the device-code grant mints directly (like refresh),
never through a provider code.

- **`POST /device_authorization`** (`device-authorize-route.ts`, pure HTTP core, 6 tests): validate the
  client (provider `lookupClient`), resolve the audience from `resource` (one allowed), intersect scopes ∩
  capability, `createDeviceCode`, and return the RFC 8628 response (`device_code`/`user_code`/
  `verification_uri`/`verification_uri_complete`/`expires_in`/`interval`). Unauthenticated by design (the
  device has no user yet); the verification URI is derived from the request origin.
- **The `/token` device grant** (`device-token-core.ts`, pure, 10 tests): `grant_type=urn:ietf:params:oauth:
  grant-type:device_code` → `pollDeviceCode` → mint. The non-approved poll states map to the RFC 8628 §3.5
  responses via the `error` kind (`OAuthErrorCode` extended with `authorization_pending`/`slow_down`/
  `expired_token` — all 400 via the existing `statusFor`); an approved code mints (`mintScopedKey`,
  authMethod `device_code`) + a refresh handle with the same audience/scope defense-in-depth + rollback as
  the auth-code path. Wired into `token-route`'s dispatch + `token-deps` (reusing its `webhook_app` pool /
  hasher / audit key); `redeemDevice` is optional in `TokenRouteDeps` (a non-device deploy reports
  `unsupported_grant_type`).
- **Wiring:** `device-deps.ts` (`makeDeviceStoreDeps` — the **real `crypto.getRandomValues`** the store
  assumed, closing A4a's MINOR-3) + `device-authorize-deps.ts` (client lookup + store) + the
  `/device_authorization` intercept in `issuer-handler` + `readTokenEnv`/`readDeviceAuthorizeEnv` gain
  `DEVICE_KV` + the `DEVICE_KV` binding in `wrangler.jsonc` (overlay `<AUTH_DEVICE_KV_ID>`).

**Tenancy invariant (no DB membership re-check on the device token path):** an approved record's props are
stamped by A4c's `setDeviceDecision`, whose org is resolved membership-gated via `getConsentOrg(sessionUserId)`
— so `props.orgId` is always the approver's own org and membership holds by construction. The token core
still applies audience/scope defense-in-depth.

**A4c (next) MUST add:** the `/device` verify → consent integration (resolve the user code → reuse the consent
screen → `setDeviceDecision`) **with the verify-path rate-limit + authed-session gate** (the ~40-bit user
code is online-guessable — still the must-before-live item). Until A4c, a polled device code stays
`authorization_pending` (nothing approves it). **Deploy slice:** provision `DEVICE_KV`; edge rate-limit
`/device_authorization` (unauthenticated, code-minting); real-KV integration (the 60s-min-TTL).
