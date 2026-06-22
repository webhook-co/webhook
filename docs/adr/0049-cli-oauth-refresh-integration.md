# ADR 0049 — CLI OAuth refresh integration (proactive + reactive, single-flight) (D8c2)

- status: accepted (**D8c2** — wires the D8b token wire into the authed surfaces: an OAuth credential now
  refreshes silently before/around expiry, the rotated handle is persisted, and a 401 triggers one
  reactive refresh + retry. The interactive `login` rewrite is D8c3.).
- date: 2026-06-22
- scope: new `packages/cli/src/oauth/{token-manager,auth-binding}.ts` (+ tests); `api-client.ts` (a
  reactive `refreshAuth` hook + mutable bearer); `commands/{shared,whoami,replay,listen}.ts` (route the
  bearer through `bindAuth`).
- relates: ADR-0046 (credential model), ADR-0047 (the `/token` refresh wire + `toOAuthCredential`),
  ADR-0036 (api-client retry loop this extends). Lane C §10.3 frozen refresh contract (always-rotates).
  `~/.claude/plans/cozy-greeting-cupcake.md` §D8.2. Lane D.
- review severity: high (token rotation + credential-at-rest). `/code-review` + a dedicated auth red-team —
  both SHIP, no blockers (loop bounded, single-flight airtight, no token leak / storage-downgrade /
  cross-send, audience server-bound). Folded NITs: a clarifying comment on the never-null `refreshAuth`
  contract; a deferred-fetch single-flight test (proves coalescing under real async latency, not just a
  synchronous fake); and the two accepted ambient risks documented in consequences below.

## context

D8b shipped `refreshAccessToken` (POST `/token` `grant_type=refresh_token`) but nothing called it. D8c2
makes every authed api call keep a valid bearer in front of it without the user re-logging in: refresh
PROACTIVELY just before the access token expires, and REACTIVELY when the server says 401. The issuer's
refresh token is single-use and ALWAYS rotates (consume-before-mint), so two concurrent refreshes would
burn the handle — the refresh must be single-flight, and the rotated credential must be persisted.

## decision

1. **`createTokenManager` owns one OAuth credential per command invocation.** `currentBearer()` returns the
   stored access key, or refreshes first when `now ≥ expiresAt − REFRESH_SKEW_MS` (60s margin, so a request
   never rides a token that expires mid-flight). `refreshAuth()` is the api-client's reactive hook. Both go
   through ONE `refresh()` that memoizes an in-flight promise (single-flight): a proactive refresh and a
   concurrent reactive 401 share the same network call, so the rotating handle is consumed exactly once.
   `Date.now` is injectable (`now`) for deterministic tests.

2. **Persist BEFORE handing out the new bearer.** After the `/token` 200, the manager writes the rotated
   credential to the store, then returns the new access key. The crash window is NOT eliminated, only
   bounded: a crash between the 200 and the persist leaves the old refresh dead server-side and the new one
   unpersisted → the next run sends the dead handle → `invalid_grant` → forced clean re-login (already
   routed to UNAUTHORIZED). A persist failure therefore PROPAGATES (never a half-state where an unpersisted
   token is used). The store write is atomic (temp+fsync+rename, file-store).

3. **The api-client gets a reactive `refreshAuth` hook.** On a `401`, if the hook is present and not yet
   used this request, the client calls it once, swaps in the returned bearer, and retries the SAME request
   — for ANY method (a 401 means the request was rejected, never processed, so the retry is safe even for a
   non-idempotent POST). The refreshed retry does not consume a retry attempt. A second 401 surfaces
   UNAUTHORIZED; an `OAuthError` from the hook (a dead refresh) propagates → re-login. An api-key
   credential passes no hook, so its 401 behaviour is unchanged.

4. **`bindAuth` is the single choke point.** Every authed surface — the read commands (`authedClient`),
   `whoami`, `replay`, and the `listen` tunnel + `--forward` client — resolves its bearer through
   `bindAuth(cred, profile, store, fetch, env)`: an api-key credential yields a static bearer with no hook;
   an OAuth credential yields the proactively-refreshed bearer + the reactive hook. The auth issuer origin
   is resolved from `WBHK_AUTH_URL`/default (the same `resolveAuthBaseUrl` the other OAuth code uses).

## consequences

- A long-lived OAuth login keeps working across the 24h access-token boundary with no user action; a
  server-side revoke or a fully dead refresh surfaces as a clean "run `wbhk login` again".
- The refresh token is never logged or displayed (it only ever travels in a POST body; `redactCredential`
  stays total over the union — ADR-0046).
- **Deferred (documented):** mid-session refresh over the long-lived `listen` TUNNEL. The tunnel uses the
  bearer resolved (and proactively refreshed) at connect; a token expiring during a multi-hour tunnel is
  not refreshed in place (a reconnect re-resolves). The `--forward` HTTP client DOES refresh reactively.
  Full tunnel mid-session refresh is a later slice if needed.
- **Accepted ambient risks (auth red-team, non-blocking):** (a) the refresh re-resolves the issuer from
  `WBHK_AUTH_URL` each run and the credential carries no mint-time `issuer` to pin against — so env-write
  access (`WBHK_AUTH_URL=https://attacker…`) could send the stored refresh handle to an attacker origin.
  This is the SAME trust boundary that already governs `WBHK_API_URL` (which receives the access bearer),
  and `resolveAuthBaseUrl` still enforces https-only + no-userinfo; a future hardening would record + pin
  the issuer at mint time. (b) A compromised API host returning 401 can churn the user's rotating refresh
  chain (one refresh per request, gated to once-per-request — no loop, no exfiltration; the handle never
  goes to that host). Both are bounded + self-healing and recorded here rather than fixed in this slice.

## alternatives considered

- **Refresh inside the credential store / on read.** Rejected — the store is a dumb persistence seam; the
  refresh policy (skew, single-flight, reactive) belongs in a manager the api-client can call, and keeping
  the store pure preserves its fake-in-tests simplicity.
- **Eliminate the crash window with a write-ahead of the in-flight token.** Rejected for D8c2 — the
  forced-re-login fallback is correct and simple; a write-ahead log adds complexity for a narrow window.
- **Gate the reactive retry on idempotency (like the transient-failure retry).** Rejected — a 401 is a
  pre-execution rejection, so retrying after refresh is safe regardless of method; gating it would leave a
  replay POST failing on an expired token that a refresh would fix.
