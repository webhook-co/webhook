# Invite return-through-login — design

**Date:** 2026-07-14
**Status:** Approved (design), pre-implementation
**Scope:** Fix the brand-new-invitee onboarding gap. Opt-in `returnTo` for the invite page only — NOT a
general deep-link-through-login feature.

## Problem

A person with **no prior webhook.co account** who is invited to an existing org loses the invite during
signup:

1. They click the emailed link → `app.webhook.co/invite/accept?org=X&token=SECRET`.
2. That page requires a session, so `verifySession()` redirects to `auth.webhook.co/login` **with no
   returnTo** — the `org`/`token` are dropped at that hop (`apps/web/src/server/session.ts:53-56`).
3. They sign up. Every signup runs `bootstrapPersonalOrg` (`apps/auth/src/runtime/bootstrap.ts:263-269`),
   giving them **their own personal org**.
4. Auth hands them to app `/`, **not** back to the invite page.
5. The onboarding gate on `/` sees a directory containing **only their personal org** (the invite is still
   unaccepted, since acceptance requires the tokened link + a session), so `classifyMembership`
   (`apps/web/src/server/onboarding-logic.ts:79-89`) classifies them as a **fresh signup** and prompts them
   to name their own org. They never auto-join the team; they'd have to re-open the invite email and click
   again.

The routing layer is **already built** to do the right thing once the team membership exists: an "invited"
user gets name-only onboarding and lands on the team, and `/` even carries a `?invite=accepted` banner
through onboarding (`apps/web/src/app/(app)/page.tsx:42-55`). So the whole fix is: **get the invite accepted
before the user reaches `/`.**

This is the "not-yet-returned `returnTo` through login is a known gap (lanes 1.1 / 2.4)" the code already
names (`apps/web/src/app/invite/accept/page.tsx:27`).

## Options considered

| Option | Actually enrols the user? | Security | Verdict |
|---|---|---|---|
| **1. Thread returnTo through login** (raw token nested through the auth handoff) | Yes | Sound, but widens the token's log footprint to the auth origin | Viable |
| **1′. Same, token in an app-origin cookie** (thread only the path) | Yes | **Best** — token never leaves the app origin | **CHOSEN** |
| 2. Auto-accept by email at signup | Yes | **Rejected** — drops the bearer token + explicit consent → silent membership injection (any user can force-join any email to a deceptively-named org); GitHub-unverified-email theft; multi-invite ambiguity | Rejected |
| 3. Invite-aware onboarding gate | **No — cosmetic** (never joins) | n/a | Rejected as a standalone fix |

Two facts from the adversarial pass that shaped the choice:

- **The token does NOT reach the OAuth provider.** Better Auth 1.6.23 stores the sign-in `callbackURL`
  server-side (the `verification` table, since auth runs a stateful `pg.Pool` — `apps/auth/src/runtime/auth.ts:235`)
  and sends only an **opaque random `state`** to Google/GitHub. Confirmed in
  `better-auth/dist/oauth2/state.mjs` + `context/create-context.mjs`. The initial fear (token → Google) is
  false.
- **A query-bearing relative `callbackURL` survives** both the OAuth round-trip and the magic-link email —
  **but only if percent-encoded exactly once.** Better Auth's trusted-origins regex accepts
  `/session/handoff?next=%2F…` and rejects a raw nested `?` with a hard `403 INVALID_CALLBACK_URL`. This is a
  footgun to pin with an integration test.
- **The nested `next` is opaque to Better Auth**, so app-controlled hops must validate it same-origin
  themselves — net-new security code, mitigated by porting the existing, tested guard.

## Chosen design — Option 1′ (app-origin cookie, accept-first)

### Flow: brand-new invitee (no session)

1. Click email → `/invite/accept?org=X&token=SECRET`.
2. `/invite/accept` detects no session and, instead of the default `verifySession()` bounce:
   - Seals `{ org: X, token: SECRET }` into a short-TTL (≈15 min) **`__Host-wh_invite`** cookie — encrypted +
     authenticated, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
   - Redirects to `${authBase}/login?redirect=/session/handoff?next=<ONCE-ENCODED /invite/accept?org=X>` —
     **path only, no token.**
3. They sign up (social or magic-link). Better Auth carries the `callbackURL` (`/session/handoff?next=…`)
   through OAuth state / the magic link → lands at `/session/handoff`, which reflects `next` into the app
   callback URL → app `/auth/callback` **validates `next` same-origin** and redirects there (fallback `/`).
4. Back on `/invite/accept?org=X`, now signed in: `org` from the URL, `token` from the cookie → render the
   Accept button → `acceptInviteAction` (unchanged: token + verified-session-email gate,
   `packages/db/src/invites.ts:152-184`) joins them, **clears the cookie**, redirects to `/?invite=accepted`.
5. They reach `/`: membership now exists → gate classifies them **invited** → name-only onboarding → team
   dashboard with the `?invite=accepted` banner.

### Flow: existing user invited (already has a session)

Unchanged. Step 2's session exists, so they go straight to the Accept button with the token in the URL. After
accept, they're already onboarded (gate is a no-op) and land on the team.

### Components (no DB migration)

1. **`apps/web/src/app/invite/accept/page.tsx`** — handle the unauthenticated branch itself: seal the invite
   cookie + build the login-with-`next` URL. On the authenticated branch, read the token from the URL when
   present, else from the cookie.
2. **New `apps/web/src/server/invite-cookie.ts`** — `sealInviteCookie` / `readInviteCookie` / `clearInviteCookie`.
   Because the payload holds a bearer token, the cookie is **encrypted + authenticated (AES-256-GCM via Web
   Crypto — native on Workers)**, not merely signed like the session cookie (which carries a value it does not
   need to hide). The key is **HKDF-derived from an existing app secret** (e.g. the session-token secret via
   `getSessionSecret()`), with a distinct `info` label — so it needs **no new Secrets-Store provisioning** and
   never reuses a key across two primitives (no HMAC/encrypt key reuse). Payload `{ org, token }`, plus the
   GCM tag for integrity; a short embedded expiry (≈15 min) rejects a stale replay even before the cookie's
   own `Max-Age`.
3. **New shared same-origin guard** — port the exact logic + test matrix of `resolvePostLoginTarget`
   (`apps/auth/src/app/(auth)/login/post-login-target.tsx` + `.test.ts:20-45`) into a reusable helper (in
   `@webhook-co/shared`, or a web-local module) — `sanitizeReturnPath(next, appOrigin) → string | null`.
   Strips `\t\n\r`, requires a single leading slash (not `//`, `/\`, `%2f`, `%5c`), resolves against the app
   origin and requires the origin to be unchanged; returns `null` (→ caller falls back to `/`) on any failure.
4. **`apps/auth/src/issuer/session-handoff-route.ts` + `session-handoff-deps.ts`** — read `next` from the
   request, validate it (same guard), thread it into `appCallbackUrl`.
5. **`apps/web/src/app/auth/callback/route.ts:56`** — read `next`, validate same-origin, redirect there
   (fallback `/`) instead of the hardcoded `/`.
6. **`apps/web/src/server/invite-actions.ts` (`acceptInviteAction`)** — read the token from the cookie when
   absent from the form; clear the cookie on success. Landing already carries `?invite=accepted`.
7. **`apps/web/src/server/session.ts`** — `verifySession()`'s default redirect is **left unchanged**;
   `returnTo` is opt-in (only the invite page builds a login-with-`next` URL). A small helper
   `loginUrlWithReturn(path)` may live here for the invite page to call.

### Security controls

- **Token hygiene:** the raw token lives only on the app origin — the invitee's inbox, the app-origin cookie,
  and (for an existing user) the app-origin URL. It never enters an auth-origin URL or log. `acceptInvite` is
  unchanged (single-use, 7-day, HMAC-hashed, gated on the verified session email — a leaked token is inert
  without the matching mailbox).
- **Open-redirect:** the `next` guard runs at **both** reflection points (the auth handoff and app's
  callback), covering the full vector set already tested for the auth guard: `//evil.com`, `/\evil.com`,
  `/%5Cevil.com`, `https:/evil.com`, `/\t/evil.com`, `/\n/evil.com`, leading-control-char smuggling. Failure
  → `/`.
- **Cookie:** encrypted + authenticated (tamper-proof), `HttpOnly` (no JS read), `Secure`, `SameSite=Lax`
  (survives the top-level nav back from the auth origin), `__Host-` prefix, short TTL.
- **Opt-in returnTo:** only `/invite/accept` threads a `next`; the shared `verifySession()` gate keeps its
  no-returnTo default, so no other gated URL leaks into auth-origin logs.

### Error handling

- `next` fails the same-origin guard → redirect to `/`.
- Cookie missing/expired on return (user dawdled past the TTL) → `/invite/accept` has org but no token → show
  the existing "invite link is incomplete — re-open the email" banner (the token is still in their inbox).
- Cookie present but token invalid/expired/revoked → `acceptInviteAction` returns `{status:"invalid"}` →
  existing invalid-invite UI.
- Already a member → `acceptInvite`'s `on conflict (org_id,user_id) do nothing` makes it idempotent.
- `next` percent-encoding wrong → Better Auth `403 INVALID_CALLBACK_URL`. We control the encoding; pinned by
  an integration test.

### Testing

- **Unit:** the same-origin guard against every vector in `post-login-target.test.ts:20-45`; cookie
  seal/unseal round-trip + tamper rejection; the invite page's unauth branch (seals the cookie + builds the
  correctly-encoded login URL); `acceptInviteAction` reading the token from the cookie + clearing it.
- **Integration (the footgun):** drive the real once-encoded `next` through Better Auth `signIn.social` and
  `signIn.magicLink` and assert no `403` — a hand-built fixture would miss this.
- **Real-Postgres:** `acceptInvite` still joins/audits correctly (existing coverage, extend if needed).
- **E2E (Playwright, if feasible):** the full brand-new-invitee walkthrough (invite → signup → return → accept
  → name-only onboarding → team dashboard).

## Non-goals / YAGNI

- No general "deep-link any gated page through login" feature — invite page only.
- No auto-accept-by-email (rejected on security grounds).
- No invite-aware gate (redundant once accept happens before `/`).
- No DB migration, no new binding.

## Rollout

- Single feature branch + PR (`feat/invite-return-through-login`), full gate + `/code-review` +
  `/security-review` (this touches auth redirects and an invite bearer token — security review is mandatory).
- No migration, so no deploy-guard interaction. Deploy auth + web together (the `next` plumbing spans both).
