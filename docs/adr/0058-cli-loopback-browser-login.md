# ADR 0058 — CLI loopback browser login + OAuth-by-default (D8c3b)

> Renumbered from **ADR 0052** (close-out audit, 2026-06-23) to resolve a number collision with
> `0052-loopback-consent-completion-bounce.md` — the CLI ADR moved to the next free number; the auth ADR kept 0052.

- status: accepted (**D8c3b** — the RFC 8252 §8.3 loopback browser OAuth flow, and the founder-decided
  switch of the DEFAULT `wbhk login` to it. Completes the D8 OAuth client.).
- date: 2026-06-22
- scope: new `packages/cli/src/oauth/loopback-login.ts` (+ tests); a loopback-server io seam
  (`context.ts` `LoopbackServer` + `IoSeams.startLoopbackServer`, `io.ts` real impl, `makeTestContext`
  fake); `commands/login.ts` rewired (default → loopback, new `--api-key`, DRY'd OAuth-persist tail);
  `login.test.ts` + `app.test.ts` updated.
- relates: ADR-0046 (credential model), 0047 (OAuth wire), 0049 (silent refresh), 0050 (device login),
  the frozen Lane C contract ([[cli-oauth-contract]]), and the founder decision (2026-06-22: default =
  loopback OAuth). `~/.claude/plans/cozy-greeting-cupcake.md` §D8.3. Lane D.
- review severity: high (OAuth login + a localhost redirect server). `/code-review` + a dedicated auth
  red-team — both SHIP, no blockers (IP-literal bind, static close-tab page, state-checked-before-code,
  S256 PKCE, no token leak, sanitized redirect error, headless → usage error all verified). Folded: the
  real loopback server now swallows post-bind socket errors (no unhandled-event crash) + has an idempotent
  `close()`. **DO-NOT-SELF-APPROVE: the browser→consent→code round-trip + the real loopback bind are a
  HUMAN E2E (like D8c3a); the CLI logic is fully fake-fetch/fake-server tested, the residual is flagged.**

## context

D8a–D8c3a built the credential model, the OAuth wire, silent refresh, and the device flow. D8c3b adds the
loopback browser flow and makes it the DEFAULT interactive `wbhk login` (the founder's OAuth-first call) —
the device flow stays behind `--device`, and the api-key paths move behind explicit opt-ins. The earlier
contract check established the issuer EXACT-matches the redirect_uri at `/authorize`, so the loopback
client must be DCR-registered per-login with the actual ephemeral port (a cached `client_id` can't work).

## decision

1. **Default `wbhk login` (interactive TTY) = loopback PKCE.** Dispatch precedence: `--device` → device
   flow; `--stdin` / `--api-key` / a set `WBHK_API_KEY` → the api-key path; otherwise an interactive TTY →
   the loopback browser flow; a headless run with no source → a usage error (can't open a browser).

2. **The interactive api-key PROMPT moved behind `--api-key`** (it was the old default). `--stdin` (pipe)
   and `WBHK_API_KEY` (env, never persisted, the headless path) are unchanged. The key is never an argv
   flag (it would leak into shell history + `ps`).

3. **`loopbackLogin` orchestration** (over injected `fetch` / loopback-server / browser): start the server
   → DCR-register the EXACT `http://127.0.0.1:<port>/callback` (per-login) → S256 PKCE + a CSRF `state` →
   open `/authorize` → capture the redirect → **verify `state` BEFORE touching the code** (a forged
   redirect can't reach the token exchange) → a redirect `error` is surfaced (control-byte-stripped) → a
   missing code is rejected → `exchangeAuthCode`. The server is ALWAYS torn down (`finally`).

4. **The loopback-server io seam binds the `127.0.0.1` IP LITERAL on an ephemeral port** — never
   `localhost` (could resolve to another interface) and never `0.0.0.0` (would expose the code-bearing
   redirect to the network). It serves its own "you can close this tab" page and resolves with the callback
   query. The real impl is coverage-excluded wiring (like `connectWebSocket`); the test fake echoes `state`.

5. **DRY:** a shared `persistOAuthLogin` (validate-before-persist → store → report) backs both the loopback
   and device flows; `method` is `oauth (loopback)` / `oauth (device)`. The refresh token is never shown
   (`redactCredential`, total over the union).

6. **DCR `client_name`.** The CLI registers with `client_name: "webhook.co CLI"` (RFC 7591) so the consent
   screen reads "Authorize webhook.co CLI" instead of the opaque generated `client_id` (surfaced by the
   founder's first e2e). The issuer stores it + the consent page renders it from the client record.

## consequences

- `wbhk login` opens a browser by default; the api-key remains available three ways (`--api-key` prompt,
  `--stdin` pipe, `WBHK_API_KEY` env). The minted access token then refreshes silently (ADR-0049).
- The loopback redirect is bound to the IP literal, the `state` is verified, and consent is server-enforced
  even on loopback — so a local impersonator can't capture the code.
- **No timeout on the loopback wait** — Ctrl-C aborts a never-completed login (the process owns the
  lifetime). A bounded timeout is a possible later refinement.
- **DO-NOT-SELF-APPROVE residual:** the real browser→consent→code round-trip and the real `127.0.0.1` bind
  are a human e2e; everything else is unit-tested with a fake server/fetch/browser.

## alternatives considered

- **Cache the DCR `client_id` across logins.** Rejected — the issuer exact-matches the redirect_uri and the
  loopback port changes per login, so the registration must be per-login.
- **Bind `0.0.0.0` or `localhost`.** Rejected — `0.0.0.0` exposes the code-bearing redirect to the network;
  `localhost` can resolve to a non-loopback interface. RFC 8252 §8.3 mandates the IP literal.
- **Keep the api-key prompt as the default `login`.** Rejected — the founder chose OAuth-first; api-key is
  still a first-class opt-in.
- **A bounded server timeout.** Deferred — Ctrl-C is sufficient for v1; a timeout can be added without an
  interface change.
