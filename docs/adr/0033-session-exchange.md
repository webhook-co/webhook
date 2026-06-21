# ADR 0033 — the `auth.`→`app.` session exchange: a single-use, audience-bound, DB-backed ticket

- status: accepted (**A-SX-1** — the store + migration; **A-SX-2a** — the `/session/exchange` redeem +
  profile read + frozen principal payload; **A-SX-2b** — the `/session/handoff` login mint, see the notes at
  the end). **A-SX is complete** — the auth.→app. handoff serves end-to-end (login → `/session/handoff` mint
  → app. callback → backchannel `/session/exchange` redeem → principal). Lane E builds the app. callback +
  the front-running hardening below.
- date: 2026-06-21
- scope: `packages/db/db/migrations/0019_auth_session_exchange.sql`, `packages/db/src/session-exchange.ts`
  (+ test:db); RLS registration in `packages/db/test/rls.test.ts`.
- relates: ADR-0028 (the refresh-token store — the org-embedded-handle + atomic-single-use pattern this
  reuses), ADR-0027 (the Better Auth runtime — the host-only cookie that makes the cross-origin handoff
  necessary), `internal/build-plans/lane-c-auth-identity-backend.md` §A-SX.
- review severity: high (a session-bearing single-use credential; one adversarial review folded).

## context

`auth.webhook.co` (login + the OAuth issuer) and `app.webhook.co` (the dashboard) are separate origins with
**host-only** session cookies — there is no shared `.webhook.co` cookie (founder X-2, ADR-0027). So after a
user logs in at auth., app. has no session; auth. must hand the authenticated principal across to app.

The handoff must not put the principal in the URL (history/referer leak) and must be single-use. The model:
auth. mints a single-use, short-TTL, opaque **exchange ticket** bound to the app. origin and redirects the
browser to app. carrying the ticket; app.'s server redeems it **backchannel** (server→server) at
`/session/exchange`, getting the principal, and establishes its own session. Only the opaque ticket ever
touches the browser; the principal travels server-to-server.

## decision (A-SX-1 — the store)

A **DB-backed** single-use ticket reusing the refresh-token store's model (ADR-0028), NOT the plan's
sketched jose-JWT-in-KV/DO:

- The ticket is `sxt_<orgId>_<secret>` — the org segment routes the tenant lookup (a hint, not a secret), so
  the redeem stays **webhook_app under RLS** with no cross-org role; the 256-bit secret is the entropy, and
  only its HMAC-SHA256+pepper hash (covering the whole plaintext) is stored (`auth_session_exchange`,
  migration 0019, tenant-RLS + FORCE, 4 policies, symmetric with `auth_refresh_token`).
- **`mintSessionExchange`** stores `{org, user_id, audience, hash, expiry}` (called at login-handoff once the
  user is authenticated, so the org/user are known). **`consumeSessionExchange`** is one atomic
  `UPDATE…used_at WHERE token_hash=? AND used_at IS NULL AND expires_at>now() AND audience=? RETURNING` — so
  single-use is exactly-one-wins (a concurrent replay loses the row lock), and the **audience is matched in
  the WHERE** (a ticket minted for one origin can't be redeemed by another, and a wrong-origin probe matches
  nothing **without burning** the ticket, so it can't DoS the legitimate redeemer).

**Why DB over jose-JWT + KV/DO:** a DB row gives true atomic single-use via `UPDATE…RETURNING` with **no
Durable Object** and **no new dep** (jose), exactly as the refresh store already does; KV single-use isn't
atomic (it would need a DO CAS for "exactly one wins"). The org-embedded handle means no cross-org role.

**The profile is NOT stored** in the ticket — A-SX-2's redeem reads `name`/`email`/`image` fresh from the
better-auth `user` row (via webhook_auth), so no identity PII is denormalized into this tenant table and the
redeemed profile is never stale.

## rejected alternatives

- **jose-signed JWT + KV/DO jti single-use** (the plan's sketch) — adds the `jose` dep and, for true
  "exactly one wins," a Durable Object CAS. The DB-handle approach is atomic without either and reuses a
  proven, reviewed pattern.
- **A self-contained signed principal in the redirect URL** — puts the principal in browser history/referer;
  the backchannel-redeemed opaque ticket avoids that.
- **A shared `.webhook.co` cookie** — rejected by ADR-0027 (host-only cookies; the exchange IS the handoff).

## consequences — A-SX-2 (next) MUST

- **`POST /session/exchange`** (the redeem): app.'s server presents the ticket → `consumeSessionExchange`
  (expectedAudience = `APP_BASE_URL`) → on a hit, read the profile from the `user` row (webhook_auth) by the
  returned `userId` → return the principal `{ orgId, userId, name, email, image }`. **Freeze this payload
  for Lane E** (their `app.` session + account panel consume it — zero `auth.` round-trip after).
- **The login-handoff mint**: after a successful auth. login destined for app., resolve the user's org
  (personalOrgId v1), `mintSessionExchange`, and redirect the browser to app. carrying the ticket.
- **Bindings/deploy**: the exchange runs as webhook_app (the tenant pool, already bound) + reads `user` as
  webhook_auth (the identity pool, already bound); no new binding. A short TTL (~60–120s — the handoff is
  immediate). An expiry-sweep job (later) prunes spent/expired rows (the DELETE policy is in place).

## test posture

The store is test:db'd (against real Postgres): mint shape + future expiry, consume single-use (+ a
concurrent "exactly one wins"), audience-mismatch (no consume, no burn), expired, unknown/malformed,
hash-only storage, plus `parseSessionExchangeOrg`. The RLS suite's TENANT_TABLES + 4-policy/grant checks now
cover `auth_session_exchange`. The redeem endpoint + the profile read + the mint-handoff are A-SX-2.

## A-SX-2a — the redeem endpoint (DONE, this slice)

A-SX-2a is the consume side: app.'s server backchannel-redeems the ticket for the principal.

- **`getAuthUserProfile(authClient, userId)`** (`packages/db/src/auth-user.ts`, test:db): reads `name`/
  `email`/`image` from the global `user` row as **webhook_auth** (the identity role, migration 0016) — the
  profile is read FRESH here, never denormalized into the ticket (so it's current + no PII in the tenant
  table). `name` is NOT NULL (Better Auth); `image` is nullable.
- **`POST /session/exchange`** (`session-exchange-route.ts`, pure HTTP core, 6 tests): require
  `application/json` → parse `{ticket}` → `consume` → on a hit, `getProfile` → return the principal. Errors:
  415 (bad MIME), 400 (missing ticket / bad JSON), **401 generic `invalid_grant`** (unknown/expired/used/
  wrong-audience all collapse to null — no oracle), 500 (the ticket was valid but the user vanished — the
  ticket is already burned, the user re-authenticates).
- **`session-exchange-deps.ts`** (glue): `consume` = `consumeSessionExchange(app, ticket, hasher,
  APP_BASE_URL)` — `expectedAudience` is the **trusted server-side constant `APP_BASE_URL`, never a request
  header**, so a ticket can only be redeemed by the app. it was minted for; `getProfile` =
  `getAuthUserProfile(authClient, …)`. Two pools: webhook_app (tenant, consume) + webhook_auth (identity,
  profile). `readSessionExchangeEnv` (HYPERDRIVE_TENANT + HYPERDRIVE_AUTH + CREDENTIAL_PEPPER). The
  `/session/exchange` intercept in issuer-handler. No new binding.

**The frozen C↔E principal payload** (200 body): `{ orgId, userId, name, email, image }` — Lane E's app.
`/auth/callback` reads it (server-to-server) to establish the app. session + populate the account panel,
needing zero further `auth.` round-trip. **No session/cookie auth** on this endpoint — the single-use,
audience-bound, unguessable ticket IS the credential (server-to-server).

**A-SX-2b (next) MUST add:** the login-handoff mint — after a successful auth. login destined for app.,
resolve the user's org (personalOrgId v1), `mintSessionExchange`, and 302 the browser to
`${APP_BASE_URL}/auth/callback?ticket=<plaintext>`. Lane E builds the app. `/auth/callback` consumer.

**Front-running / ticket-theft (security, A-SX-2b + deploy MUST address):** the ticket transits the browser
URL in that redirect, so anyone who observes it (history, `Referer`, an extension, proxy logs) could
`POST /session/exchange` BEFORE app.'s server does → account takeover of that login. Single-use + the
audience binding bound the window but don't close it. Mitigations, all on the mint/deploy side (this redeem
endpoint is correct as-is): (a) a **tight TTL (~30–60s)**; (b) `Referrer-Policy: no-referrer` on the redirect
+ app. stripping the ticket from the URL immediately on landing; (c) **caller authentication between app. and
auth.** (a shared deploy secret header validated against a binding, or a Cloudflare service binding / mTLS)
so a leaked ticket alone is insufficient — strongly recommended defense-in-depth. Plus: the deploy expiry-
sweep job; the `HYPERDRIVE_AUTH` binding (already required by the session runtime, now also the profile read)
must be provisioned against `webhook_auth`; and a consent-screen-free already-signed-in fast path.

## A-SX-2b — the login-handoff mint (DONE, A-SX e2e)

A-SX-2b is the producer: `GET /session/handoff` is where app. sends an unauthenticated visitor.

- **`session-handoff-route.ts`** (pure HTTP core, 4 tests): `handleSessionHandoff` — read the session (no
  session → 302 to `/login?redirect=<relative /session/handoff>`, returning here after); resolve the org
  (`getConsentOrg` → 500 on the bootstrap-anomaly no-org case); `mintSessionExchange` (TTL 60s); **302 to
  `${APP_BASE_URL}/auth/callback?ticket=…` with `Referrer-Policy: no-referrer`** + `cache-control: no-store`.
- **`session-handoff-deps.ts`** (glue): lazy `makeAuth` (session) + lazy webhook_app pool (`getConsentOrg`
  + `mintSessionExchange`, audience = `APP_BASE_URL`); the no-session login bounce pays for neither pool.
  The handoff env is just `AuthEnv` (session + tenant + pepper), so the mount reads it with `readAuthEnv` —
  no new env reader or binding. The `/session/handoff` intercept in issuer-handler.

**Front-running mitigations (from A-SX-2a's review), as built:** the short 60s TTL + `Referrer-Policy:
no-referrer` on the redirect are in place. The ticket still transits app.'s callback URL, so **Lane E must**
strip it from the URL on landing and redeem it server-side immediately; and the **deploy slice should add an
app.↔auth. shared secret / service binding** on `/session/exchange` so a leaked ticket alone is insufficient
(defense in depth — the ticket is already single-use + audience-bound + unguessable + 60s).

**CSRF note (GET that mints):** `/session/handoff` is a GET that mints a ticket, so a cross-site **top-level
navigation** (`window.open` / a clicked link / a 302 — these carry the **SameSite=lax** session cookie; a
subresource `<img>`/`fetch` GET does **not**, so those can't trigger it) can cause a mint against the
victim's session — but the response is a 302 whose `Location` (the only place the ticket appears) is
unreadable cross-origin, so the attacker can't obtain the ticket; the unused ticket simply expires. Harmless
(a minor mint; the deploy rate-limit covers volume).

**Deploy rate-limit MUST cover `/session/handoff`.** Today it's the only session-cookie-gated mint route
with **no `RATELIMIT_KV` binding** (`/device/verify` has one; the magic-link send is throttled). It shares
A3d `/authorize`'s posture (lazy pools, edge rate-limit deferred), so the deploy slice's edge/WAF rate-limit
must list `/session/handoff` explicitly — a driven victim's browser can otherwise mint unbounded
(self-expiring) exchange rows.

**A-SX is done.** Remaining is Lane-E (the app. `/auth/callback` consumer) + the deploy items above.
