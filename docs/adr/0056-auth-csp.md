# ADR 0056 — Content-Security-Policy + security headers for the auth UI

- status: accepted
- date: 2026-06-23
- scope: `apps/auth` (the login / consent / device UI on auth.webhook.co)
- relates: [ADR-0021](0021-opennext-cloudflare-workers-app-and-auth.md) (OpenNext, no middleware);
  [ADR-0044](0044-turnstile-magic-link-captcha.md) (the Turnstile login captcha — the one third-party the UI
  loads); apps/www's `_headers` (the CSP precedent this mirrors).

## context

The auth UI shipped no Content-Security-Policy or response-hardening headers; ADR-0044 noted CSP hardening
for the auth surfaces was tracked separately. This closes that: the auth UI is a credential-bearing trust
surface (login + the consent/device approval screens) and should carry at least the header hardening
apps/www already ships, plus the framing/plugin lockdown a login page warrants.

## decision

**A static CSP + the standard hardening headers, set in `next.config.ts` `headers()` (applied to every
Next-served response), with the policy defined in a unit-tested `src/security-headers.ts` module.**

- **Static, not nonce-based.** A per-request nonce CSP is the stronger design, but it requires middleware to
  mint the nonce and stamp it onto both the header and Next's injected `<script>`s. OpenNext on Workers has
  **no middleware** (ADR-0021), so — exactly as apps/www documents for its static export — `script-src` and
  `style-src` fall back to `'unsafe-inline'` (Next hydrates via inline `self.__next_f.push(...)` scripts; a
  bare `'self'` returns 200 but silently breaks interactivity). **React's output-escaping remains the primary
  XSS defense;** this CSP is defense-in-depth.
- **Tight everywhere else.** `default-src 'self'`; `frame-ancestors 'none'` + `X-Frame-Options: DENY`
  (clickjacking); `object-src 'none'`; `base-uri 'self'`; `form-action 'self'` (the magic-link form posts to
  `/api/auth` same-origin; social sign-in is a top-level redirect, not a cross-origin form post). `img-src`
  adds `data:`; `font-src 'self'`.
- **One third-party origin: Cloudflare Turnstile.** The login captcha loads its script, widget iframe, and
  telemetry from `challenges.cloudflare.com`, so it's allowlisted in `script-src`, `frame-src`, and
  `connect-src` — and a test pins that it is the *only* off-origin in the policy.
- **Hardening headers (apps/www parity):** `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` (cross-origin requests carry only the origin, so a
  consent/device ticket in the query never leaks), `Permissions-Policy: camera=(), microphone=(),
  geolocation=()`, and `Strict-Transport-Security: max-age=63072000` (leaf host — no includeSubDomains/
  preload, mirroring www's caution).

## consequences

- The auth UI gains framing/plugin/base-uri/form-target lockdown + a constrained script/connect/frame
  origin set + HSTS — a real improvement over no CSP, shipped today without waiting on a nonce story.
- **Tradeoff (documented, not hidden):** `'unsafe-inline'` on `script-src`/`style-src` means the CSP does not
  itself block an injected inline script — output-escaping is the XSS backstop. Tightening to a nonce/hash
  policy is a **follow-up gated on a Workers nonce-injection mechanism** (shared with apps/web, which has the
  same OpenNext constraint and should adopt the same module).
- Set via `next.config.ts headers()` (OpenNext honors the headers manifest); the policy lives in a unit-tested
  module so the directives can't silently drift. **Verify post-deploy** that the header is present on a UI
  response and that login (Turnstile render + solve), magic-link, and social redirect all still work under it.
- Roll-out option if caution is wanted: ship as `Content-Security-Policy-Report-Only` first (same policy, zero
  breakage), observe, then flip the header name to enforcing — a one-line change in the module.
