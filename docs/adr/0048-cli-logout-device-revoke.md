# ADR 0048 — CLI logout, device-flow poll, and token revoke (D8c1)

- status: accepted (**D8c1** — the first command-layer slice of the OAuth client: the RFC 8628 device-flow
  request/poll functions, the RFC 7009 revoke wire, the `wbhk logout` command, and `whoami`'s auth
  method/source. The interactive `login` rewrite + silent refresh are D8c3/D8c2.).
- date: 2026-06-22
- scope: new `packages/cli/src/oauth/{device,revoke}.ts` + `packages/cli/src/commands/logout.ts` (+ tests),
  `packages/cli/src/commands/whoami.ts` (method/source), `packages/cli/src/app.ts` (register `logout`).
- relates: ADR-0046 (credential model — the union `logout`/`whoami` discriminate over), ADR-0047 (the wire
  toolkit `endpoints`/`http`/`token-client` these build on), the frozen Lane C contract (cli-oauth-contract
  memory). `internal/build-plans/lane-d-cli.md` §D8, `~/.claude/plans/cozy-greeting-cupcake.md` §D8.3. Lane D.
- review severity: high (OAuth client security — token revocation + credential teardown). `/code-review` +
  `/security-review` (auth lens) — both SHIP, no blockers. Two findings folded: (a) `logout` no longer
  claims a clean "logged out." when `WBHK_API_KEY` is set (the env backend outranks the store and can't be
  erased) — it now reports honestly; (b) defense-in-depth: server-controlled OAuth error `error`/
  `error_description` are now control-byte-stripped at `readOAuthError` (they flow to stderr via
  `OAuthError.userMessage`, bypassing the text renderers' `sanitizeControl`).

## context

D8b shipped the dormant token wire (PKCE/DCR/`/token`). D8c wires it into commands. This first sub-slice
(D8c1) lands the pieces that are fully headless-testable — no browser/consent leg — so they self-verify via
fake-`fetch`: the device-flow request/poll functions, the revoke wire, the `logout` command that uses them,
and `whoami`'s new method/source surfacing. The login rewrite (loopback PKCE + `--device`) is D8c3, where
the only un-headless leg (browser→consent→code) lives and is a human e2e.

## decision

1. **Device flow = two pure functions over the injected `fetch`.** `requestDeviceAuthorization` POSTs the
   form (`client_id`/`scope`/`resource`) to `/device_authorization` and zod-validates the response
   (`device_code`/`user_code`/`verification_uri`/`expires_in`/`interval`, optional `verification_uri_complete`).
   `pollDeviceToken` POSTs the `urn:ietf:params:oauth:grant-type:device_code` grant to the FROZEN `/token`
   and maps the RFC 8628 §3.5 polling errors (`authorization_pending`→`pending`, `slow_down`→`slow_down`,
   `access_denied`→`denied`, `expired_token`→`expired`) to a `DevicePoll` variant for the caller's loop;
   any other error is a hard `OAuthError`. The poll functions own no timing — the `interval`/`slow_down`
   backoff is the D8c3 login loop's job (kept here so the wire stays synchronous + fake-fetch-testable).

2. **Revoke is best-effort and refresh-token-only (RFC 7009).** `revokeToken` POSTs `{token}` as a form
   field; the response status is NOT inspected (the issuer returns 200 for any well-formed token and never
   leaks existence). The CLI sends the **refresh** handle — the issuer discriminates `rtk_` vs `whk_` by
   prefix and cascades to the access key + evicts the authz cache. Only a transport failure propagates.

3. **`logout` revokes-then-clears for OAuth; clears-only for API keys.** It resolves the active profile,
   then: `null`→"not logged in, nothing to do" (no erase); an OAuth credential→revoke the refresh token
   server-side (best-effort: a failure prints a note and still clears) then `store.erase`; an **API-key**
   credential→`store.erase` LOCALLY only, never revoked (it may be a shared, dashboard-issued key the user
   didn't mint and shouldn't kill from a `logout`). A set `WBHK_API_KEY` can't be erased (it's env, not the
   store) → an explicit note. Output never echoes any token.

4. **`whoami` adds auth method + source.** `method` = `api-key` | `oauth (<loopback|device>)`; `source` =
   `env (WBHK_API_KEY)` (the env backend has highest read precedence, so a set var IS the active credential)
   | `stored credential`. Both are CLI-derived (no `sanitizeControl` needed); added to the text and `--output
   json` views. The redacted handle stays total over the union (ADR-0046) — the refresh token is never shown.

## consequences

- `logout` works today for both credential shapes; the device functions are ready for the D8c3 `--device`
  login loop; `whoami` now distinguishes how/where you're authenticated.
- Token security holds: revoke sends body-only, never inspects/echoes; `whoami`/JSON never emit the refresh
  token (regression-tested).
- The device poll has no sleep/loop here — D8c3 owns the timed polling; this keeps D8c1 deterministic.

## alternatives considered

- **Revoke the API key on logout too.** Rejected — an API key may be shared/dashboard-issued; killing it
  from a local `logout` would be a surprising, possibly cross-machine, side effect. OAuth tokens are
  per-login and CLI-minted, so revoking those is correct.
- **Inspect the revoke response / surface revoke failures as errors.** Rejected — RFC 7009 is fire-and-forget
  by design (no existence leak); a logout must always clear locally, so a revoke failure is a note, not a
  failure exit.
- **Put the device polling loop (with sleeps) in `pollDeviceToken`.** Rejected — keeping the wire synchronous
  makes it fake-fetch-testable; the timed loop is the command layer's concern (D8c3).
