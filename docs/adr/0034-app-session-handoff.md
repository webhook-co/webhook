# ADR 0034 — the app.-side session handoff + the signed session cookie (E7)

- status: accepted
- date: 2026-06-21
- scope: `apps/web` (`/auth/callback`, the session gate, the session cookie)
- relates: [ADR-0033](0033-session-exchange.md) (Lane C's `auth.`-side A-SX — the ticket mint +
  `/session/exchange` this consumes); [ADR-0023](0023-app-session-gate-dal.md) (the DAL gate — this closes
  its load-bearing "E7 must verify the cookie value" requirement); [ADR-0021](0021-opennext-cloudflare-workers-app-and-auth.md)
  (OpenNext, no middleware); the Lane E build-plan (slice E7).

## context

E5 stood up the DAL gate trusting cookie **presence** (any non-empty `wh_session` → a mock principal), with
the load-bearing note that **E7 must verify the cookie value**. Lane C has now shipped the `auth.`-side A-SX
(ADR-0033): after login, `auth.` mints a single-use, audience-bound ticket and 302-redirects to
`app.webhook.co/auth/callback?ticket=…`; `POST auth./session/exchange {ticket}` atomically burns it and returns
`{ orgId, userId, name, email, image }`. E7 builds the **`app.` side**: redeem the ticket, establish app.'s own
session, and make the gate verify it.

## decision

**A signed, self-contained session cookie established by `/auth/callback`, verified on every gated request.**

- **`/auth/callback` (the one `auth.` touch on the v1 path).** Reads the ticket, backchannels
  `POST /session/exchange` (the single-use credential — ADR-0033), signs the returned principal into app.'s own
  cookie, and **302s to the dashboard with a clean URL** (the ticket never enters history). `Referrer-Policy:
  no-referrer` + `Cache-Control: no-store`. Any failure — absent/invalid/expired/replayed ticket or a transient
  exchange error — redirects to sign-in and sets no cookie. It's pre-auth (it *establishes* the session), so it
  carries the `dal-gate-allow:` marker.
- **The session cookie is a self-contained signed token, not a server-side handle.** The principal came from a
  trusted backchannel, so app. is **stateless**: the cookie value is
  `base64url(payload).base64url(HMAC-SHA256(secret, body))` carrying `{ orgId, userId, name, email, image, iat,
  exp }`. HMAC-SHA256 over Web Crypto matches the repo's token convention (the A-SX ticket, the audit chain) — **no
  JWT dependency added**. Verification is constant-time and **fails closed** (returns null → the gate redirects)
  on any signature mismatch, expiry, or malformed input.
- **`verifySession` now verifies the value.** It reads the cookie and decodes+verifies it into the principal;
  a forged/tampered/expired token is rejected, never trusted. This closes ADR-0023's E7 requirement. The mock
  principal is gone.
- **Host-only, hardened cookie.** `__Host-wh_session` in production (the prefix the browser only accepts with
  Secure + Path=/ + no Domain), a plain `wh_session` in dev so it works over http://localhost; `HttpOnly`,
  `SameSite=Lax`, 7-day TTL. `api.`/`mcp.` stay bearer-only — this cookie is `app.`-only and never a parent
  `.webhook.co` cookie (ADR-0021/0027).
- **Secret resolution fails closed in prod.** `SESSION_TOKEN_SECRET` (the HMAC key) is a Secrets Store binding
  read per-request via `getCloudflareContext()`; in dev/test it falls back to a fixed dev secret, but in
  **production a missing secret throws** rather than signing sessions with a default. `AUTH_BASE_URL` (where to
  backchannel) defaults to the prod auth host.
- **`/dev-session` mints a real token.** Now that the gate verifies the value, the dev-only bootstrap signs a
  real token for a fixed mock principal (still 404 in prod — prod is fail-closed, no path but the handoff sets
  the cookie).

## consequences

- The handoff is **stateless** — no app.-side session store; the signed cookie is the session, and after the
  exchange app. never calls back to `auth.` (the profile rode in on the exchange response).
- **Revocation model (stateless tradeoff).** Because there is no server-side session store, an individual
  app. session cannot be revoked server-side before its cookie expiry. Concretely: **logout clears only the
  cookie on the device that initiated it** — a token already issued to another device stays valid until it
  expires — and the only fleet-wide kill-switch is **rotating `SESSION_TOKEN_SECRET`** (invalidates every
  signed cookie at once, forcing re-login everywhere). The 7-day lifetime + `HttpOnly` + the host-only cookie
  are therefore the primary bounds on a leaked cookie. **API-key and device-grant revocation are unaffected**
  — those are durable DB state (Lane B), evicted from `KV_AUTHZ` on revoke; only the *app.-session* cookie is
  stateless.
- **Considered: a per-user session epoch (deferred, 2026-06-23).** Targeted revocation ("log out everywhere",
  or force-revoke one user without rotating the global secret) could be added by storing a per-user
  `session_epoch` in the DB, stamping it into the token at issuance, and having `verifySession` reject a token
  whose epoch is behind the user's current one (bump the epoch to revoke). **Deferred deliberately:** the DAL
  gate is intentionally stateless — an epoch check adds a **DB read to every gated request** (latency + a
  Hyperdrive dependency on the hot path), a poor trade for the current risk (single personal org, `HttpOnly`,
  7-day TTL, and the rotate-secret kill-switch already exists). **Revisit when** any of: sessions span
  shared/multi-member orgs, the TTL lengthens materially, or "log out everywhere"/forced per-user revocation
  becomes a product requirement — at which point a short-TTL cached epoch (KV) keeps the per-request cost
  bounded.
- **Deploy obligations:** provision `SESSION_TOKEN_SECRET` (256-bit) in Secrets Store + set `AUTH_BASE_URL`; and
  per ADR-0033, add the app.↔auth. shared-secret/service-binding on `/session/exchange` (defense-in-depth) and
  the rate-limit on `auth./session/handoff`. `AUTH_LOGIN_URL` should point at `auth./login` per env so the gate's
  unauthenticated redirect lands on the real sign-in surface.
- E6's credential actions consume the real `session.orgId`/`userId` once E8 wires the live DB — the `Session`
  shape is unchanged, so only the principal's *source* changed here.
- The token carries the profile (`name`/`email`/`image`) so the account panel reads it from the session with no
  extra round-trip; it's not secret, but it is `HttpOnly` (no client-JS read) and never logged.
