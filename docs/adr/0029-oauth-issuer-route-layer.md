# ADR 0029 — the OAuth-issuer route layer: `/token` at the wrangler `defaultHandler`, not a Next route

- status: accepted (A2b-2b — the auth-code `/token` route; **A2b-3** — the refresh-token grant, see below, so `/token` now serves both grants). `/revoke` (A2b-4) and the `/authorize` consent→mint (A3) inherit this layer.
- date: 2026-06-20
- scope: `apps/auth/src/issuer/{token-route,token-deps,token-error,issuer-handler}.ts` + `apps/auth/src/worker.ts` (the mount) + `apps/auth/src/runtime/env.ts` (`readTokenEnv`) + `packages/db/src/orgs.ts` (`isOrgMember`); 3 seam-signature refinements to `token-core.ts`.
- relates: ADR-0024 (Option-B token issuance — this realizes its `/token`), ADR-0028 (the refresh-token store this wires), ADR-0021 (OpenNext-on-Workers — the bundling constraint that forces this layer), ADR-0010 (auth foundation r5/r7), `internal/build-plans/lane-c-auth-identity-backend.md` §2.
- review severity: high (the live credential-minting endpoint)

## context

A2b-2b wires the frozen `/token` (the C↔D contract) to the real provider + Lane B + the A2b-2a refresh
store. Two things shaped the design beyond ADR-0024's plan.

**1. The provider helpers can't bundle as a Next route.** `/token` needs the provider's in-process helpers
(`getOAuthApi(config, env).unwrapToken` / `.revokeGrant`) to decrypt + revoke the opaque grant — they're
KV-bound to the Worker that mounts the provider. But `@cloudflare/workers-oauth-provider` eagerly imports
`cloudflare:workers`, and **OpenNext's esbuild can't externalize that for a Next server function**
(`serverExternalPackages` → `next build`'s page-data collection evaluates it and fails; a lazy `import()` →
`next build` passes but OpenNext's esbuild then copies the package and still can't resolve
`cloudflare:workers`). Wrangler externalizes `cloudflare:*` natively (proven by A2b-1's `worker.ts`).

**2. The A2a seams were under-specified for the real wiring.** Three seams needed consent context that
`redeemAuthCode` has post-unwrap but the seam signatures didn't carry.

## decision

**1. Issuer-helper routes are handled at the wrangler layer, not as Next routes.** The OAuth provider's
`defaultHandler` (the fall-through after it claims `/oauth/token`, `/register`, `/authorize`, `.well-known/*`)
is `makeIssuerDefaultHandler(openNextHandler)` (`issuer-handler.ts`): it intercepts `POST /token` and
delegates everything else to OpenNext (the pages, `/api/auth/*`, the consent UI). This runs in the
wrangler-bundled `worker.ts` graph, where `cloudflare:workers` resolves. `issuer-handler.ts` is
type-checked (structural `FetchHandler`/`ExecutionLike` types, no Workers-global lib); only `worker.ts`
stays tsc-excluded (the generated `.open-next` import). **`/revoke` (A2b-4) and the `/authorize`
consent→mint POST (A3) inherit this same intercept layer.**

**2. The `/token` flow.** A pure route-core (`token-route.ts`, unit-tested) parses the urlencoded body,
dispatches on `grant_type`, and maps `RedeemResult` → an OAuth token/error response (`no-store`; 400 for
client errors, 500 for `server_error`, `authorization_pending` per RFC 8628). The deps builder
(`token-deps.ts`, I/O glue) supplies the seams: `exchangeAuthCode` subrequests the provider's `/oauth/token`
same-origin (the opaque token never reaches the client, never logged); `unwrapToken`/`revokeProviderGrant`
via `getOAuthApi`; `mintScopedKey`/`isOrgMember`/`revokeGrant` over Lane B; `issueRefreshToken` over the
A2b-2a store. The provider's error code is sanitized to our `OAuthErrorCode` (`token-error.ts`, pure,
tested) — no provider free-text leaks. `refresh_token` is dispatched via an optional injected
`redeemRefresh` (unwired here → `unsupported_grant_type`; A2b-3 wires it — no route-core change needed).

**3. Three seam refinements (FrozenTokenBody untouched).** `revokeProviderGrant(pgId)` → `(pgId, userId)`;
`issueRefreshToken(grantId)` → `(grantId, orgId, audience)`; `rollbackMint(grantId)` → `(grantId, orgId)`.
All thread post-unwrap **consent** context (`props.userId`/`orgId`/`audience`), never request-derived — so
audience/scope/tenancy still come only from consent. (Extends ADR-0024's "frozen seams" — the contract the
plan froze was the `/token` body, which is unchanged; the injected-seam shapes evolved at implementation.)

**4. The grant is the absolute session ceiling.** `mintScopedKey` is called with
`grantTtlSeconds = ~90d` (= the "grant lifetime" the consent screen advertises). The refresh consume gate
(`g.expires_at > now()`, ADR-0028) enforces it, so a perpetually-rotated refresh handle still terminates at
90d → re-login. Without a grant TTL the chain would renew forever.

**5. `isOrgMember(app, userId, orgId)`** (new, `packages/db/orgs.ts`) is the tenancy bind `redeemAuthCode`
asserts before minting — RLS-org-scoped, tested (member / non-member / cross-org).

## cross-slice invariant (A3 must honor)

`props.userId` MUST equal the userId A3's `/authorize` sets on the provider grant (the provider keys grants
by user). A mismatch makes the best-effort G1 revoke silently no-op and leak the vestigial opaque grant
until KV TTL; the mint still succeeds (the opaque was never delivered), so it can't be caught at `/token`.
Pinned in a comment on the `revokeProviderGrant` seam.

## rejected alternatives

- **`/token` as a Next route handler** — blocked: OpenNext's esbuild can't bundle the provider's eager
  `cloudflare:workers` import for a server function (tried externalize + lazy-import; both fail). The
  wrangler-layer intercept sidesteps it entirely.
- **A separate issuer Worker** — the provider's opaque grants are KV-bound to the mounting Worker, so
  unwrap/revoke must run there; a second Worker would need a service binding back just to unwrap. More
  moving parts, zero gain.
- **Shimming `cloudflare:workers`** — fragile, fights the toolchain.
- **Keeping the A2a seam signatures** — would force a stateful per-request holder to smuggle the
  post-unwrap org/user into the seams; threading the values is simpler + explicit.

## consequences

- **A2b-3 — the refresh grant (DONE, this extends the ADR).** A pure wiring slice: `RefreshDeps` in
  token-deps (`consumeRefresh`→`consumeRefreshToken`; `listGrantScopes`→`listApiKeysForGrant` scope union;
  `mintKeyForGrant`→Lane B) + `redeemRefresh` injected into the issuer dispatch; the route-core already
  dispatched `refresh_token`. **Two** token-core seam refinements (not one — FrozenTokenBody untouched):
  `listGrantScopes(grantId)` → `(grantId, orgId)` AND `mintKeyForGrant({grantId,scopes,ttlSeconds})` →
  `({grantId,orgId,audience,scopes,ttlSeconds})` — both thread the grant's org+audience from the consumed
  refresh handle, never the request, so a refresh can't retarget org or audience. **Consent-scope source:**
  the union of the grant's **non-revoked** api_keys' scopes (the first auth-code key anchors the full
  consent; refreshes only narrow → re-widening tops out at the original consent, never beyond). Revoked
  keys are excluded (future per-key revocation withdraws that scope); EXPIRED keys are kept (the
  full-consent first key expires at the 24h key TTL — dropping it would lose the ceiling). The refresh mint
  is audited via `mintKeyForGrant`'s `key_minted`; grant status+expiry is gated in `consumeRefreshToken`.
- **The deploy slice MUST bind** `HYPERDRIVE_TENANT`, `CREDENTIAL_PEPPER`, `AUDIT_CHAIN_HMAC_KEY`, `OAUTH_KV`
  before `/token` is routed (`readTokenEnv` fails closed without them; named in `wrangler.jsonc`).
- **Test posture:** the route-core + `mapProviderTokenError` + `isOrgMember` + the seam-arg assertions are
  unit/db-tested; the deps builder + `issuer-handler` dispatch are I/O glue, verified by `build:cf` /
  `deploy:dry` (the bundle composes — 7.9 MB) — an accepted gap (no testable logic skipped).
- **`@cloudflare/workers-oauth-provider` is NOT in `serverExternalPackages`** — it's imported only by the
  wrangler layer (`worker.ts` → `issuer/`), never by `next build`.
