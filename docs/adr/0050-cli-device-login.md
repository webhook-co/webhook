# ADR 0050 — CLI device-flow login (`wbhk login --device`) (D8c3a)

- status: accepted (**D8c3a** — the first interactive OAuth login: the RFC 8628 device flow. Additive — a
  new `--device` flag; the existing api-key paths (`--stdin` / `WBHK_API_KEY` / interactive prompt) are
  unchanged. The loopback-PKCE browser flow + any change to the DEFAULT login are a separate slice (D8c3b),
  gated on a founder product decision.).
- date: 2026-06-22
- scope: new `packages/cli/src/oauth/device-login.ts` (+ tests); `commands/login.ts` (`--device` path +
  `--auth-url`); `context.ts`/`io.ts` (two io seams: `openBrowser`, `sleep`); test-harness fakes.
- relates: ADR-0046 (credential model), ADR-0047 (device wire + `toOAuthCredential`), ADR-0049 (the refresh
  manager that keeps the minted token fresh), the frozen Lane C contract ([[cli-oauth-contract]]).
  `~/.claude/plans/cozy-greeting-cupcake.md` §D8.3. Lane D.
- review severity: high (OAuth login). `/code-review` + a dedicated auth red-team — both SHIP, no blockers.
  Two defense-in-depth MINORs folded (both hostile-issuer-gated, matching the readOAuthError precedent):
  (a) the device-flow stderr write now `sanitizeControl`s the server-controlled verification_uri + user_code;
  (b) `openBrowser` is only auto-invoked for a verification URL on the ISSUER's own origin (rejects a
  hostile `file://`/cross-origin URL), and the Windows launcher switched from `cmd /c start` to
  `rundll32 url.dll,FileProtocolHandler` to keep the URL a clean argv element. **The actual human approval
  round-trip (user opens the browser + approves) is a HUMAN E2E — DO-NOT-SELF-APPROVE; the CLI logic is
  fully fake-fetch tested, the residual is flagged for founder verification.**

## context

D8a–D8c2 built the credential model, the OAuth wire, and silent refresh, but no command mints an OAuth
credential yet. D8c3a adds the device flow — the most self-contained interactive login: it has NO browser
redirect to capture (unlike loopback PKCE), so the CLI just prints a code + URL and polls. That makes the
entire CLI side headless-testable; only the user's in-browser approval is out of band. It also works on a
headless/remote box (no loopback port), which is its own reason to ship first.

## decision

1. **`deviceLogin` orchestration is a pure-ish function over injected `fetch`/`sleep`/`now`.** It requests
   the device + user codes (`/device_authorization`), prints the verification URL + user code, best-effort
   opens the browser, then polls `/token` with the device-code grant: `authorization_pending` → keep
   polling; `slow_down` → +5s to the interval (the client's RFC 8628 §3.5 duty — the poll error carries no
   interval); `access_denied`/`expired_token` → an `OAuthError`; a client-side deadline (`now ≥ start +
   expires_in`) also stops with `expired_token`. Returns the minted `FrozenTokenBody`.

2. **`login --device` wires the real io + persists.** DCR-registers a fresh public client (a port-less
   `http://127.0.0.1/callback` loopback literal satisfies `/register`, though the device flow never uses a
   redirect), requests `CAPABILITY_SCOPES` (the canonical list from `@webhook-co/contract`; an empty scope
   is rejected by the issuer), runs `deviceLogin`, synthesizes the OAuth credential (`authMethod: "device"`),
   **validates it via `/v1/whoami` BEFORE persisting** (mirrors the api-key path — a bad mint stores
   nothing), then stores it (honoring `--insecure-storage`). The minted access token refreshes silently
   thereafter (ADR-0049). The refresh token is never displayed (`redactCredential`, total over the union).

3. **Two new io seams: `openBrowser` + `sleep`.** `openBrowser(url)` is a best-effort per-OS launcher
   (`open`/`xdg-open`/`cmd start`, no shell, detached, errors swallowed — the printed URL is the fallback).
   `sleep(ms)` is the wall-clock seam so the device-poll backoff is instant under test. Both are
   coverage-excluded real impls in `io.ts`; the test harness defaults `openBrowser`/`sleep` to no-ops.

4. **Register fresh per login (no client_id cache yet).** Caching a `client_id` is deferred — and is anyway
   incompatible with the loopback flow's per-ephemeral-port redirect (D8c3b), where `/authorize`
   exact-matches the registered `redirect_uri` (verified against the issuer). A device login is rare +
   user-initiated, so per-login DCR is acceptable.

## consequences

- `wbhk login --device` is a complete, headless-capable OAuth login; everything except the user's browser
  approval is unit-tested. **A human must run it once against prod `auth.webhook.co` to confirm the approval
  round-trip mints a usable token** (the do-not-self-approve residual).
- The DEFAULT `wbhk login` is UNCHANGED (still the api-key path) — switching the interactive default to
  OAuth loopback is a deliberate product decision deferred to D8c3b.
- OAuth login targets the hosted api (`resource = https://api.webhook.co`); the audience is server-bound
  from approval regardless. Self-host + OAuth is out of scope (self-host uses an api key).

## alternatives considered

- **Change the default `login` to OAuth now.** Deferred — removing the interactive api-key prompt is a UX/
  product call for the founder; `--device` is purely additive and safe to ship first.
- **Cache the DCR `client_id`.** Deferred — incompatible with the loopback per-port redirect, and a rare
  user-initiated device login doesn't amplify the (un-rate-limited) `/register` meaningfully.
- **Put the poll loop's timing inside the device wire (`pollDeviceToken`).** Rejected (ADR-0048) — the wire
  stays synchronous + fake-fetch testable; the timed loop lives here over an injected `sleep`.
