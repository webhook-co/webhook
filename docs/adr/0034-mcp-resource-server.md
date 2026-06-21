# ADR 0034 — `apps/mcp` as a resource server: two-validator bearer auth + introspection + principal isolation

- status: accepted (**A8a** — the bearer-resolution layer: the promoted introspection contract, the
  opaque-token introspection validator, and the two-validator prefix discriminator. **A8b** (the
  resource-server teardown + mount) and **A8c** (per-request principal isolation) extend this ADR — see the
  "still to build" section).
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
