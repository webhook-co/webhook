# ADR 0044 — Cloudflare Turnstile on the magic-link send (Better Auth captcha plugin)

- status: accepted
- date: 2026-06-22
- scope: `apps/auth/src/runtime/{auth,env,urls,auth-client}.ts` + tests; the login form
  `apps/auth/src/app/(auth)/login/{login-form.tsx,turnstile.tsx,login-form.test.tsx}`;
  `scripts/gen-wrangler-prod.mjs` (+`TURNSTILE_SECRET_KEY`); `apps/auth/wrangler.jsonc` (comment).
- relates: ADR-0027 (the Better Auth runtime + the durable magic-link rate limit this complements),
  `internal/build-plans/lane-c-auth-identity-backend.md`.
- review severity: medium (a public, email-sending endpoint's abuse surface; no new authz boundary — the
  gate sits in front of an existing endpoint and fails closed on a missing/invalid token).

## Context

`POST /api/auth/sign-in/magic-link` is unauthenticated, emails a caller-supplied address, and touches the
DB — a sensitive, abuse-prone surface that we defend in depth. The shipped controls layer:

1. a **durable, per-recipient throttle** (ADR-0027) — fleet-wide rate limiting keyed to the target address;
2. an **edge/WAF flood-shield** — coarse per-source volume limiting in front of the Worker;
3. **proof-of-humanity** on the send — the subject of this ADR.

Turnstile adds layer 3: an automated client must pass a human-interaction challenge before a send is
accepted, complementing the throttle and the flood-shield.

## Decision

Add **Cloudflare Turnstile** as a proof-of-humanity on the magic-link **send**, via **Better Auth's
built-in `captcha` plugin** (`better-auth/plugins`, provider `cloudflare-turnstile`) — NOT a standalone
managed siteverify Worker.

- **Why the plugin, not a separate Worker.** `apps/auth` already runs a Better Auth server. The plugin is
  an `onRequest` hook that reads the `x-captcha-response` header, calls Cloudflare siteverify server-side,
  and rejects (`MISSING_RESPONSE` 400 / `VERIFICATION_FAILED`) before the handler runs. The
  `sendMagicLink` callback never sees the request/token, so a pre-handler gate is the only viable layer —
  and the plugin is exactly that, with no extra Worker, hop, or deploy.
- **Scope: magic-link send only.** `endpoints: ["/sign-in/magic-link"]` REPLACES the plugin defaults
  (substring-matched), so social login and session reads stay ungated, and the GET magic-link
  verify-click (the emailed link, which has no widget) is untouched. Social redirects to Google/GitHub
  (their own bot defenses, no email vector), so gating it would add friction for little gain.
- **Replay hardening.** `allowedHostnames: [<origin host>]` (derived from the configured `baseURL`, so prod
  → `auth.webhook.co`, dev → `localhost`) is the load-bearing anti-replay pin; `expectedAction:
  "turnstile-spin-v1"` rejects a token minted for another action on this sitekey (the action is
  client-set + echoed by siteverify, so it's same-sitekey defense-in-depth, not a standalone boundary).
  Note the server pins a SINGLE host per deploy — a dev's `AUTH_BASE_URL` host must match the browser
  address (localhost vs 127.0.0.1).
- **Conditional wiring (fail-open when unconfigured, fail-closed when present).** The plugin is wired only
  when `TURNSTILE_SECRET_KEY` is bound (always in prod, via the deploy overlay), so local/test runs boot
  without it — mirroring the optional `RATELIMIT_KV` throttle. A present-but-empty secret throws at
  `resolveAuthSecrets` (never wire a keyless gate). Once the secret is bound, a send without a valid token
  is rejected — so the backend and the form-widget ship in **one PR/deploy** (deploying the gate without
  the widget would break login).
- **Token delivery.** The widget posts the solved token via the `x-captcha-response` header
  (`fetchOptions.headers` on the Better Auth client) — never a body field, so the magic-link request body
  is unchanged. The sitekey is public (committed as `TURNSTILE_SITEKEY`); the secret lives in Secrets Store.

## Consequences

- The login form (`login-form.tsx`) gains a captcha widget and a submit gated on a solved token; the real
  `Turnstile` component is injected through a `Captcha` prop (default), so tests drive a fake through the
  same seam they use for `actions`. **This is clickable UI → it requires a human eyeball** (the widget
  renders Cloudflare's iframe; verify it appears, the send is blocked until solved, and succeeds after).
- The widget loads Cloudflare's Turnstile script; CSP hardening for the auth surfaces is tracked separately
  (out of scope here). Social login is intentionally ungated — it redirects to Google/GitHub, which carry
  their own bot defenses and no email vector. Further hardening of the login surfaces is tracked in
  `internal/`.
