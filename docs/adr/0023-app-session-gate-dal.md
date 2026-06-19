# ADR 0023 — the app. dashboard auth gate (Data-Access-Layer)

- status: accepted
- date: 2026-06-20
- scope: `apps/web`
- relates: [ADR-0021](0021-opennext-cloudflare-workers-app-and-auth.md) (decided "gate auth with the DAL
  pattern, not middleware" — this ADR is its implementation + rules); the Lane E build-plan
  (`internal/build-plans/lane-e-auth-frontend.md`); the forthcoming handoff/E7 ADR.

## context

`app.webhook.co` (the dashboard) is private — every surface requires a session. `@opennextjs/cloudflare`
doesn't support Next 16 middleware (ADR-0021), so the gate can't live in `middleware.ts`/`proxy.ts`. It has
to be a **server-side data-access gate** that each protected entry point calls. E5 builds that gate and the
dashboard shell with a **mock session**; the real session arrives from the `auth.`→`app.` handoff in E7.

## decision

**A single `verifySession()` Data-Access-Layer gate, behind a `server-only` boundary, called first-line in
every server entry point that exposes tenant data.**

- **`verifySession()`** (`src/server/session.ts`, `import "server-only"`) reads the session cookie via
  `cookies()`; **redirects to the sign-in surface when it's absent**, otherwise returns the session principal
  (`orgId` + `userId` + profile). `redirect()` is typed `never`, so a missing session can't fall through.
- **Gate everywhere — the layout gate is not enough.** A `(app)/layout.tsx` gate covers page *renders*, but
  **server actions and route handlers are invoked directly, bypassing the layout**. So every server component,
  **server action, and route handler that touches tenant data calls `verifySession()` itself** (e.g.
  `settings/page.tsx` calls it even though its layout already did). This is what the forthcoming **CI
  ungated-path guard** (a follow-up slice) enforces statically.
- **`logout` is the one deliberate exemption** — it owns the session cookie and scopes no tenant data, so it
  clears the cookie and redirects without gating.
- **The session cookie is host-only.** E5 uses `wh_session` (the mock phase); **E7 hardens it to
  `__Host-wh_session`** (Secure + Path=/ + no Domain), set over https from the handoff. `api.`/`mcp.` stay
  bearer-only — this cookie is `app.`-only.
- **Mock bootstrap is dev-only and fail-closed in production.** A `/dev-session` route mints the mock cookie
  so the gated dashboard is reachable before E7 — but it **returns 404 when `NODE_ENV === "production"`**
  (`next build` inlines that), so in production *nothing* sets the cookie and the gate redirects every request
  to sign-in. There is no production bypass.

## ⚠️ load-bearing requirement for E7

The E5 gate trusts **cookie presence** (any non-empty `wh_session` yields the mock principal) because there is
no real issuer yet. **E7 MUST replace the mock with real validation** — `verifySession()` has to *decode and
verify* the cookie value (the handoff-issued, signed/opaque session) and derive `orgId`/`userId`/profile from
it. Until then a forged `wh_session=anything` would pass — which is harmless only because no production path
sets the cookie (see above). This is the single most important thing E7 changes.

## consequences

- The `(app)` route group is fully gated; its routes are dynamic (`ƒ`) because `cookies()` opts out of static
  generation — expected for a private dashboard.
- `apps/web` retires its showcase identity: the `/design` showcase, `motion-demo`, and the coming-soon root
  are removed; `/` is the dashboard home (→ `/settings`).
- Test harness: `server-only` is aliased to a no-op stub under vitest (the real marker throws outside a server
  build); the gate tests mock `next/headers` + `next/navigation` and assert the redirect-on-absent semantics.
- A `server-only` import keeps the gate (and the session principal) out of every client bundle.
