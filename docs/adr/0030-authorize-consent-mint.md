# ADR 0030 — `/authorize` consent→mint: the stateless signed consent ticket

- status: accepted (**A3c** — the pure consent core + the signed-ticket codec; **A3d** (next) wires the
  wrangler-layer mount + the real provider/session/DB seams — it will extend this ADR).
- date: 2026-06-21
- scope: `apps/auth/src/issuer/{consent-ticket,consent-core}.ts` (+ tests); `packages/shared/src/index.ts`
  (re-export base64url/HMAC/timing-safe primitives); `apps/auth/src/issuer/token-core.ts` (the `ConsentProps`
  contract is unified here — see decision 4).
- relates: ADR-0024 (Option-B token issuance — `/authorize` produces the grant `/token` redeems), ADR-0029
  (the wrangler-layer issuer-route layer A3d's mount inherits), ADR-0026 (the C↔E consent contract + the
  loopback-redirect policy), ADR-0019/0020 (the mint + governance schema), `internal/build-plans/
  lane-c-auth-identity-backend.md` §2 (A3).
- review severity: high (the interactive consent + grant-creation path; two adversarial reviews folded).

## context

`/authorize` is the interactive half of the issuer: the browser arrives from the CLI's loopback PKCE flow,
the user approves, and we create the OAuth grant (whose encrypted `props` the frozen `/token` later reads to
mint a `whk_`). Two facts shape the design:

1. **The provider has no server-side store for an in-flight authorization.**
   `@cloudflare/workers-oauth-provider`'s `parseAuthRequest` is stateless and `completeAuthorization` mints
   the grant fresh from an `AuthRequest` — there is nowhere on the server to stash the parsed request between
   the consent GET and the decision POST. So the authorization state must be **carried by the client** across
   the round-trip (GET /authorize → Lane E's consent screen → POST /consent/decision).

2. **The consent screen is Lane E's clickable UI; the backend is Lane C's.** A3 must split cleanly: Lane C
   produces the consent state + consumes the decision; Lane E renders + POSTs. The handoff is a data artifact,
   not a shared render path.

## decision

**1. The state crosses the round-trip in a signed, expiring "consent ticket"** (`consent-ticket.ts`). The
ticket is `<base64url(JSON payload)>.<base64url(HMAC-SHA256 tag, 16-byte truncated)>` — the exact codec the
cursor uses (`packages/shared/src/cursor.ts`), keyed by a dedicated 32-byte `CONSENT_TICKET_KEY` (never
reused from another key). It seals BOTH:

- the authorization-critical state replayed into `completeAuthorization` at the decision — the parsed
  `AuthRequest` (PKCE challenge, redirect_uri, state, resource) + the **server-authenticated `userId`** + the
  resolved `orgId`/`scopes`/`audience`; and
- the consent **display** fields Lane E renders (client name, org name, origin, scopes, both durations).

`verifyConsentTicket` returns the payload only if the MAC recomputes (constant-time) AND `exp` has not passed
(inclusive through `exp`); any tampered/forged/expired/malformed ticket returns `null` — callers fail closed
on one check. The codec is pure Web Crypto + base64url (no `cloudflare:workers`), so it imports cleanly into
BOTH the wrangler-layer decision handler (A3d) AND **Lane E's Next consent page** (E8 calls
`verifyConsentTicket` + `consentRequestFromTicket` to render). The ticket is the `requestId` echoed back with
the `ConsentDecision`.

**2. `buildConsent` (GET /authorize) — pure, injected seams.** It validates and resolves, then signs a
ticket: re-validate `redirect_uri` is an http loopback literal (`isAllowedRedirectUri`, A3a) — if not, **400,
never a redirect** (we won't bounce to an untrusted host); the **audience comes only from the request
`resource`**, normalized to exactly one allowed resource (no default, no widening) else an `invalid_target`
redirect; **scopes = requested ∩ capability** (`org_policy` has no per-org scope allow-list, so there is no
org-policy read here — that part of the plan was over-specified), empty → `invalid_scope`; resolve the org
via the injected `getConsentOrg`; resolve the client display name (`lookupClient`, falling back to the
client_id). OAuth errors go to the (validated) `redirect_uri` with the echoed `state`; an untrusted request
is a 400.

**3. `decideConsent` (POST /consent/decision) — pure, injected seams.** Verify the round-tripped ticket
against the **live session**: require a session (`401`), a valid ticket (`400`), the ticket's `userId` ==
the live session user (`403` — a stolen/forwarded ticket can't be approved by another session), and the
double-submit CSRF nonce == the sealed one (`403`). Re-assert the sealed `redirect_uri` is loopback before
redirecting (defense in depth; fails closed on a malformed payload). On **approve** →
`completeAuthorization({request, userId, scope, metadata: {}, props})`; on **deny** → redirect to the client
with `error=access_denied` + state, never minting. PII (device name) lives only in the encrypted `props`,
never in the provider's unencrypted `metadata`.

**4. One `ConsentProps` for both halves of the G1 contract.** consent-core (the WRITER, via
`completeAuthorization` props) and token-core (the READER, via `unwrapToken`) now share a single
`ConsentProps` exported from `token-core.ts` — so the G1 cross-slice invariant (ADR-0029: the userId set on
the grant must equal `props.userId` so the post-mint provider-grant revoke doesn't no-op) can't drift. The
canonical `device` shape is `{ name: string }` (matching the consent contract). `decideConsent` passes the
same `userId` as both the grant userId and `props.userId`, satisfying G1 by construction.

## rejected alternatives

- **A server-side authorization store (KV/DO) keyed by an opaque requestId** — the provider already has no
  such store and adding one duplicates grant state, adds an eviction concern, and buys nothing the signed
  ticket doesn't: the ticket is integrity-protected, expiring, and self-cleaning.
- **Encrypting the ticket (AES-GCM) instead of signing it** — would also hide the (signed-but-readable) PII
  the ticket carries in the `/consent?ticket=` URL. Deferred, not adopted for v1: the flow is same-origin
  loopback and the ticket is short-lived; see the must-before-go-live note. (Revisit if the ticket ever
  carries more sensitive PII or rides a leakier channel.)
- **Putting the ticket codec in `@webhook-co/shared`** — it's issuer-specific and consumed only by apps/auth
  (the worker layer + Lane E's page); only the byte/HMAC primitives are shared.

## consequences

- **A3d (next) wires the mount + real seams** at the wrangler `defaultHandler` (ADR-0029): GET `/authorize`
  + POST `/consent/decision` intercepts → `getOAuthApi().parseAuthRequest`/`lookupClient`/
  `completeAuthorization`; `sessionUserId` from `auth.api.getSession` (cookie-derived — never the body); a
  new `getConsentOrg(app, userId)` DB read (the user's deterministic personal org id + a membership-gated
  name lookup, test:db); `readAuthorizeEnv` (AuthEnv + `CONSENT_TICKET_KEY` + `OAUTH_KV`); a `getSession` on
  `RuntimeAuth`. GET /authorize 302s to `/consent?ticket=…`; the decision POST returns `{ redirectTo }`
  (the consent form navigates there — approve = the loopback callback with the code; deny = the
  access_denied bounce). No migration (read-only).
- **C↔E contract frozen for Lane E E8:** the consent page reads `?ticket=`, calls `verifyConsentTicket` +
  `consentRequestFromTicket(ticket, payload)` to render the `@webhook-co/contract` `ConsentRequest`, and
  POSTs `{ requestId: ticket, csrfToken, decision }` to `/consent/decision`, then navigates to the returned
  `redirectTo`. E8 also renders the `keyTtlSeconds` row (the contract carries both durations — A3b).
- **MUST-BEFORE-GO-LIVE (deploy/rate-limit slice):** (a) the `CONSENT_TICKET_KEY` 32-byte secret must be
  provisioned (Secrets Store) before `/authorize` is routed (`readAuthorizeEnv` fails closed); (b) a short
  ticket TTL (the A3d mount sets `ticketTtlSeconds`; single-use of the resulting auth code is the provider's,
  not the ticket's — so keep the window tight, magic-link-style ~5 min); (c) edge rate-limiting on the public
  `/authorize` + `/consent/decision` (joins the accumulated `/token`+`/revoke`+magic-link rate-limit work);
  (d) consider encrypting the ticket if its PII surface grows.
- **Test posture:** the ticket codec (round-trip, tamper, wrong-key, expiry boundary, malformed) + both
  consent cores (every result branch, the G1 call shape, the redirect/error paths, empty-state) are
  unit-tested with fakes (29 tests). The A3d deps builder + mount are I/O glue → verified by `build:cf`/
  `deploy:dry`; `getConsentOrg` is test:db'd.
