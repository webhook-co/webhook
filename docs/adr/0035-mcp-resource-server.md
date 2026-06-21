# ADR 0035 — `apps/mcp` as a resource server: two-validator bearer auth + introspection + principal isolation

- status: accepted (**A8a** — the bearer-resolution layer: the promoted introspection contract, the
  opaque-token introspection validator, and the two-validator prefix discriminator. **A8b** — the
  resource-server teardown + mount. **A8c** — per-request principal isolation (the A8c section). **A8 is
  complete** — mcp is a pure resource server with cross-principal session isolation; remaining work is the
  deploy slice (the `AUTH_ISSUER` binding + the api PRM repoint).
- date: 2026-06-21
- scope (A8a): `packages/contract/src/introspection.ts` (+ barrel), `apps/mcp/src/introspect-client.ts`,
  `apps/mcp/src/resolve-bearer.ts` (+ tests); `apps/auth/src/issuer/introspect-core.ts` /
  `introspect-handler.ts` (the audience shape this consumes).
- relates: ADR-0029 (the auth. issuer-route layer that ships `IssuerIntrospect`, A2b-5), ADR-0010/0011 (the
  api-key bridge + the deferred mcp session-binding follow-up this finally hardens), ADR-0024 (Option-B —
  why the first-party `whk_` path exists alongside opaque provider tokens),
  `internal/build-plans/lane-c-auth-identity-backend.md` §A8.
- review severity: high (the resource server's authz/cross-tenant boundary; one adversarial security review
  folded — see "review" below).

## context

Today `apps/mcp` co-locates an `@cloudflare/workers-oauth-provider` OAuth issuer AND validates the tokens it
mints (ADR-0010/0011): the provider's tokens are opaque + KV-bound to the issuing Worker, so an issuer
elsewhere couldn't validate them, so mcp issued its own. Now that Lane C stands up the real issuer on
`auth.webhook.co` (A1–A4: login → consent → mint, the device flow, refresh, revoke, and the
`IssuerIntrospect` introspection RPC), mcp must STOP being an issuer and become a pure **resource server**
of `auth.` — one issuer, many resources (api., mcp.).

A resource server must validate two credential kinds on the `Authorization: Bearer` header:

1. a first-party **`whk_` access key** (the CLI / api-key callers) — resolved by the existing api-key
   credential chain (`makeApiKeyAuthDeps` → `VerifyBearer`), audience-bound to `MCP_RESOURCE`;
2. an **opaque OAuth provider token** (generic 3rd-party MCP clients) — which mcp cannot validate locally
   (it's KV-bound to the `auth.` Worker), so it INTROSPECTS it via `auth.`'s `IssuerIntrospect.introspect`
   over a Cloudflare service binding (RFC 7662-shaped), then applies its own RFC 8707 audience binding.

A8 is split into three PRs (mirroring A2b/A3): **A8a** = the bearer-resolution layer (this slice, pure +
injected, fully unit-tested); **A8b** = the teardown of the co-located `OAuthProvider` + the resource-server
mount (the router, PRM now pointing at `auth.`, the `WWW-Authenticate` challenge, `/mcp` gated by A8a);
**A8c** = per-request principal isolation (the critical fix the ADR-0011 follow-up deferred).

## decision (A8a — the bearer-resolution layer)

- **The introspection contract is promoted to `@webhook-co/contract`** (`introspection.ts`:
  `IntrospectionResult` + `TokenIntrospector`). It is the single source of truth both sides share: `auth.`'s
  handler shapes it, mcp's client parses it, against ONE definition (explicit named barrel re-export, not
  `export *` — the Turbopack footgun, since `apps/auth` is a Turbopack consumer). `apps/auth`'s
  `introspect-core.ts` re-points to import it (type-only — no runtime-binding hazard).

- **The opaque-token validator** (`makeIntrospectVerifyBearer`) adapts introspection to the SAME
  `VerifyBearer` seam the api-key path uses, so the resource-server authorize logic stays uniform. It fails
  closed: an inactive token, or an active result missing a usable principal (non-string/empty `orgId`,
  non-array/non-string `scopes`, non-string `userId`), is an EXPECTED rejection (`UnauthenticatedError` →
  401); a binding fault propagates (→ 5xx, never a masked 401).

- **Audiences are surfaced FAITHFULLY and bound STRICTLY (sole resource).** `IntrospectionResult.audience`
  is `string | string[]` and `auth.`'s handler no longer collapses a multi-value audience to its first
  element. mcp's `assertSoleAudience` accepts a token only if its audience is EXACTLY `MCP_RESOURCE` (a
  single value equal to it) — a token also bound to api. is a parallel credential usable elsewhere, which mcp
  does not honor (RFC 8707 + R4, "no vestigial parallel credential"). A token with no audience can't be
  confirmed against this resource and is rejected. *(This closes the F1 finding below: a lossy
  `audience: string` shape would have made mcp blind to a multi-resource token, an order-dependent
  cross-resource replay once introspection is wired.)*

- **Two-validator dispatch is by PREFIX, exactly one validator, no fall-through** (`makeResourceVerifyBearer`):
  `whk_` (the `API_KEY_PREFIX` + mintCredential's `_` separator) → the api-key chain; anything else → the
  introspection validator. A single Authorization header is one credential in one slot; trying the second
  after the first rejects would let an attacker feed a `whk_`-shaped value to introspection (or vice versa)
  to probe both, or turn one validator's reject into the other's accept. Discriminate once, commit; the
  chosen validator's outcome (ok / 401 / operational throw) is final. Both validators audience-bind to
  `MCP_RESOURCE` internally, so the audience flows through unchanged.

## rejected alternatives

- **A locally-defined `IntrospectionResult` on each side** — duplicates the cross-Worker RPC shape and
  invites drift; the contract package is its home.
- **`audience: string` (collapse a multi-value audience)** — bakes in a blind spot (F1); faithful
  `string | string[]` + a sole-resource check is the safe shape.
- **"audience CONTAINS MCP_RESOURCE"** — RFC-permissible for multi-resource tokens, but it would honor a
  token also valid at api.; the webhook mint is single-audience by design, so sole-resource is the safe
  default (relax later only if a real multi-resource client emerges).
- **Try both validators / fall back** — an auth-confusion and probing vector; prefix-discriminate once.

## review (A8a)

One adversarial security review (red-team: auth bypass, audience confusion, fail-open, contract drift).
Verdict MERGEABLE. Folded: **F1** (MAJOR) — the faithful-audience shape + sole-resource binding above;
**F2** (MINOR) — the `userId` type guard; **F6** — the array-audience + multi-resource-rejection +
non-string-userId tests. Verified sound and unchanged: the 401-vs-5xx split, the prefix-discriminator's
exactness (case-sensitive, anchored, no fall-through), and the type-only contract re-point (no Turbopack
hazard).

## consequences / still to build

- **A8b (the mount, NEXT) MUST:** tear down `new OAuthProvider(...)` in `apps/mcp/src/index.ts` → a plain
  router; serve RFC 9728 PRM via `buildProtectedResourceMetadata` with `authorization_servers = [the auth.
  issuer]` (NOT mcp); serve the `WWW-Authenticate` challenge on 401/403; gate `/mcp` with A8a's
  `VerifyBearer` (api-key chain + the real `env.AUTH_ISSUER.introspect` binding) and set `ctx.props` for the
  McpAgent DO; remove `/authorize`, `/token`, `/register`, and `resolveExternalToken`. **Deploy ordering:
  `auth.`'s `IssuerIntrospect` must be live before mcp's `services → auth.` binding flips (CF late-binds).**
- **A8c (the critical fix) MUST:** per-request principal isolation. `McpAgent.serve` routes the DO purely by
  the `Mcp-Session-Id` and reads props from the execution context (no `props` arg, no DO-name hook — verified
  in the library), and `this.props` is set once at session init and NOT refreshed on warm requests. So a
  reused session id with a different principal's bearer would read the first principal's org. Fix:
  principal-namespaced session routing (bind the DO name to the principal) + an in-DO bound-principal check
  (reject a request whose principal ≠ the one stored at init), validated against a REAL warm DO (the
  `@cloudflare/vitest-pool-workers` harness mcp already uses).
- **Deploy slice:** the `AUTH_ISSUER` service binding (entrypoint `IssuerIntrospect`) on mcp; an audience-less
  opaque token is rejected (fail closed), so the PRM must advertise the resource so compliant clients always
  send `resource`.

## decision (A8b — the resource-server teardown + mount, DONE)

`apps/mcp` is no longer an OAuth issuer: `new OAuthProvider({...})` is gone. The default export is now a plain
resource-server handler.

- **`resource-handler.ts`** (pure, injected, 8 tests): serves the RFC 9728 PRM (`authorization_servers =
  [https://auth.webhook.co]` — NOT mcp), a health check, and gates `/mcp` with `authenticateBearer`
  (scope-FREE: the per-capability scope check runs downstream in the shared handler, `read-handlers.ts`,
  against `ctx.scopes` — it was never at the boundary). On a valid bearer it sets the resolved principal on the
  execution context (`setProps` → `ctx.props`, the same contract the OAuthProvider used) BEFORE handing off to
  the McpAgent DO; on 401 it returns the PRM-pointing `WWW-Authenticate`. An OPTIONS preflight bypasses auth
  (the transport answers CORS; no data, no DO state). An operational fault PROPAGATES → a 500 at the wrapper
  (never a masked 401).
- **`index.ts`** wires the real per-request deps: the two-validator `verifyBearer` (the `whk_` api-key chain
  over webhook_authn + KV cache, plus opaque-token introspection over the `AUTH_ISSUER` service binding), the
  PRM doc, and `WebhookMcp.serve("/mcp")`. PRM + health are served DB-free up front; one short-lived authn
  client, closed in `finally`. Mirrors `apps/api`'s resource-server shape.
- **Teardown:** removed `OAUTH_KV` (binding + the generator's `<OAUTH_KV_ID>` placeholder/TOKEN/GH-var),
  `default-handler.ts`, `external-token.ts`, the `@cloudflare/workers-oauth-provider` dep. The former issuer
  endpoints (`/.well-known/oauth-authorization-server`, `/register`, `/token`) now 404 — proven by the
  rewritten `resource-server.test.ts`. The api-key→`/mcp`→DO e2e (`mcp-tools.test.ts`, fixed to a real `whk_`
  token so it routes to the api-key validator) is preserved.

**Deploy-window behavior (intentional):** `AUTH_ISSUER` is deploy-injected later (the ordering above), so right
after this merges `env.AUTH_ISSUER` is undefined in prod. A `whk_` token never touches it (the only prod path
today); a non-`whk_` (opaque) token hits `undefined.introspect` → a clean **500** denial (not a bypass). The
deploy slice adds the binding before any real OAuth-token traffic.

## review (A8b)

Two adversarial reviews (security red-team + fresh-eyes). Both MERGEABLE, no BLOCKER/MAJOR. Confirmed: scope
enforcement preserved downstream, audience binding intact on both validators, the `ctx.props` hand-off correct
(verified against `agents@0.16.1`: `serve().fetch` reads `ctx.props` → `onStart(props)`), `AUTH_ISSUER`-undefined
fails safe, the OAUTH_KV/generator teardown fully consistent (no orphan binding / missing placeholder), OPTIONS
safe. Folded 4 comment-staleness NITs. **Deferred follow-ups:** repoint `apps/api`'s PRM `TOKEN_ISSUER` from
mcp → auth. (out of A8b's file scope — the deploy slice); the `AUTH_ISSUER` overlay binding + closing the
deploy-window opaque-token 500 (deploy slice); per-request principal isolation (A8c).

## decision (A8c — per-request principal isolation, DONE)

The threat: the MCP streamable-HTTP transport (`McpAgent.serve`) routes the `WebhookMcp` Durable Object PURELY
by the `Mcp-Session-Id`, and the DO's principal (`this.props`) is set ONCE at session init (not refreshed on
warm requests — verified in `agents@0.16.1` / `partyserver`). The library exposes no DO-name hook and no
per-request principal to the DO. So a session id reused by a DIFFERENT principal (with their own valid bearer)
would route to the FIRST principal's warm DO and read THEIR org.

The fix is at the resource-server EDGE (not in the DO — the library makes the in-DO approach the plan sketched
infeasible): a signed session-binding envelope.

- **`session-binding.ts`** (pure, 11 tests): `bindSessionId(key, baseId, digest)` wraps the transport's
  assigned session id into `<base64url(json{b,p})>.<base64url(hmac-16)>` (the cursor/consent-ticket codec) —
  `b` = the base id the transport routes by, `p` = the initializing `principalDigest`. `unbindSessionId(key,
  wrapped, digest)` returns `b` ONLY if the MAC recomputes AND the bound `p` equals the presenting principal's
  digest; otherwise null (malformed / tampered / forged / wrong-key / WRONG-PRINCIPAL all collapse to null —
  no oracle). `principalDigest(ctx)` = `sha256(canonical-JSON{o:orgId, u:userId|null})` — canonical JSON so the
  org/user boundary is unambiguous (no crafted value can collide a different (org,user) pair; **folded MAJOR-1**
  — the earlier raw-separator encoding relied on ids never containing the delimiter). Bound to IDENTITY, not
  the token/scopes, so a refreshed/re-scoped token for the same principal keeps its session. `MCP_SESSION_KEY`
  = a dedicated 32-byte HMAC secret (loud length check; fails CLOSED → 500, never open).
- **`resource-handler.ts`**: the `/mcp` branch now, after auth: an inbound session id MUST `unbindSession` to
  the current principal (mismatch → 404 before the transport routes); on success the id is unwrapped to the
  base id the transport expects. Any transport-assigned id on the response (the `initialize`) is re-wrapped to
  the principal-bound id, so the client only ever holds the bound id (bind is deterministic → one stable id).
- **`index.ts`** reads `MCP_SESSION_KEY` and injects the bind/unbind closures.

**How the guarantee holds:** to reach principal A's DO (`streamable-http:G`), B must present a session id that
unbinds to A's `G` under B's digest — which requires either A's envelope (fails the `p == digest(B)` check) or
a forged envelope (fails the MAC; B lacks the key). Both → 404 before the transport. `G` itself is the library's
unguessable `newUniqueId()`, never exposed to the client (only the wrapped id leaves the handler).

## review (A8c)

Two adversarial reviews (security red-team + fresh-eyes). Both MERGEABLE, no BLOCKER. Verified: MAC-before-trust
ordering (no pre-MAC oracle), forgery infeasible, no distinguishing 404 oracle, fail-CLOSED key handling, the
init/echo re-wrap deterministic + bound to the right principal, OPTIONS/GET/DELETE all flow through the gate,
and the cross-principal isolation proven against a REAL warm DO (`session-isolation.test.ts`: B reusing A's
session id → 404; A keeps its session → 200). Folded: **MAJOR-1** (canonical-JSON digest, above), MINOR (the
stale `mcp-agent.ts` SESSION BINDING comment → corrected to the as-built edge mechanism; the `tag()` cast
comment). **Deferred follow-ups:** an envelope version/domain tag + a session `exp` (rotation self-heal) —
neither widens cross-tenant exposure (the `p`-binding still requires the owner's bearer); a GET-SSE/DELETE
e2e (the code path is method-agnostic + already gated). **Deploy MUST:** provision `MCP_SESSION_KEY` as a
FRESH, INDEPENDENT 32-byte secret (the code's length check guards a missing/short key, not a reused one).
