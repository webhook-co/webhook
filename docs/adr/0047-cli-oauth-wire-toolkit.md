# ADR 0047 — CLI OAuth wire toolkit (PKCE + DCR + the /token client)

- status: accepted (**D8b** — the OAuth token wire: PKCE, dynamic client registration, the auth-code
  exchange + refresh rotation. Dormant — no command calls it yet; D8c wires it into login/refresh + adds
  the device flow + revoke).
- date: 2026-06-22
- scope: new `packages/cli/src/oauth/{endpoints,pkce,http,dcr,token-client}.ts` (+ tests),
  `packages/cli/src/errors.ts` (`OAuthError`, `InvalidAuthUrlError`).
- relates: ADR-0046 (the credential model these mint into), the frozen Lane C contract (cli-oauth-contract
  memory + `~/.claude/plans/cozy-greeting-cupcake.md` §D8). `internal/build-plans/lane-d-cli.md` §D8. Lane D.
- review severity: high (OAuth client security). One AUTH red-team + one code review — both SHIP; the
  red-team's userinfo-confusion hardening was folded.

## context

The CLI has no static `client_id` and must register dynamically, then run a PKCE authorization-code (or
device) flow against `auth.webhook.co` and refresh the rotating handle. This slice is the WIRE — pure
request/response functions over an injected `fetch`, so the whole OAuth client is unit-tested with
fake-fetch (the plan's D8.1 "token-wire bed", which becomes the D8c suite). No command, browser, or
persistence here.

## decision

1. **Endpoints are hardcoded at the issuer root, not from discovery.** `oauthEndpoints(origin)` →
   `/register`, `/authorize`, `/token`, `/device_authorization`, `/revoke` (the exact pathnames
   `issuer-handler.ts` dispatches). Discovery is deliberately NOT used: the provider's discovery
   `token_endpoint` is the opaque `/oauth/token`, whereas the CLI must hit Lane C's FROZEN `/token` (the
   `whk_` FrozenTokenBody). `resolveAuthBaseUrl` mirrors the api/tunnel validators — https-only (http only
   for loopback), no query/fragment, **no embedded userinfo** (rejects the `https://real@evil` form), with
   `--auth-url`/`WBHK_AUTH_URL` overrides.

2. **S256 PKCE.** `deriveChallenge` = base64url(SHA-256(verifier)) (verified against the RFC 7636 vector);
   `generatePkce` is a 32-byte CSPRNG verifier; `randomState` for CSRF. The issuer is S256-only, so `plain`
   is never offered.

3. **Public-client DCR.** `registerClient` POSTs an RFC 7591 JSON registration (`token_endpoint_auth_method:
   "none"`, all three grant types, `response_types: ["code"]`) and returns the `client_id`. Redirect-URI
   loopback-IP-literal enforcement is the SERVER's boundary (and D8c's loopback server) — this module just
   sends what it's given.

4. **The `/token` client.** `exchangeAuthCode` + `refreshAccessToken` POST form bodies (secrets in the body,
   never the URL), zod-validate the `FrozenTokenBody`, and map a 400 `{error}` (or a malformed body) to a
   typed `OAuthError` carrying the closed-taxonomy code (→ UNAUTHORIZED exit; the user message shows only
   the code, never the token). `toOAuthCredential` synthesizes the CLI-side fields the wire doesn't return
   (`expiresAt = now + expires_in·1000`, `audience = resource`, `authMethod`, `clientId`) into the
   `OAuthCredential` (ADR-0046). Refresh returns the rotated body and does NOT persist — the caller (D8c)
   must, and the crash-window (200 received, not yet persisted → forced re-login) is documented.

## consequences

- D8c can drive a complete login (register → PKCE authorize → exchange → store) and a silent refresh with
  these functions, and unit-test them against fake-fetch — the only un-testable leg is the actual
  browser→consent→code round-trip (a human e2e).
- Secret material is body-only; tokens never hit a log or the URL; the refresh token never reaches an error
  message.
- Dormant: no behaviour ships in D8b (no command imports the toolkit yet).

## alternatives considered

- **Use RFC 8414 discovery for endpoint URLs.** Rejected — discovery's `token_endpoint` is the provider's
  opaque `/oauth/token`, not the frozen `/token` the CLI needs; the first-party paths are stable.
- **Confidential client (with a secret).** Rejected — a CLI can't keep a secret; public client + PKCE is
  the RFC 8252 native-app pattern, and the issuer enforces S256 + loopback redirects.
- **Persist inside `refreshAccessToken`.** Rejected — the wire stays pure (no store dependency); the
  single-flight + atomic persist is the command-layer's job (D8c), keeping the toolkit fake-fetch-testable.
