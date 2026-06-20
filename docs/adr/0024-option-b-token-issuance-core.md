# ADR 0024 — Option-B token issuance: the `/token` redemption + mint core (A2a)

- status: accepted (A2a — the pure, I/O-free `redeemAuthCode`/`redeemRefresh` cores). **A2b extends this ADR** with the live `@cloudflare/workers-oauth-provider` × OpenNext mount and the real dependency wiring.
- date: 2026-06-20
- scope: `apps/auth/src/issuer/token-core.ts` (+ `token-core.test.ts`) — the dependency-injected token-redemption logic only. No route handler, no provider, no DB in this slice; the mount + real seams are A2b.
- relates: ADR-0010 (auth foundation, **r5/r7** — login mints a scoped `whk_`), ADR-0019 (credential mint model — `mintScopedKey`/`mintKeyForGrant` + the **A0c caller-side refresh-subset contract**), ADR-0020 (governance schema — the per-key `audience`), ADR-0021 (OpenNext app & auth), `internal/build-plans/lane-c-auth-identity-backend.md` §2/§10.
- review severity: high (token issuance; the audience / scope / tenancy seam on the credential surface)

## context

ADR-0010 (r5) settles "OAuth login **mints a scoped `whk_` key**." The naive reading — "the OAuth
`/token` endpoint returns a `whk_`" — is **impossible** with the chosen library: `@cloudflare/workers-oauth-provider`
claims its own `tokenEndpoint` before the default handler and exposes **no token-body hook**, so the
provider's `/oauth/token` can only ever return its own opaque token. Lane C therefore runs **two token
endpoints** (Option B): the provider validates the PKCE authorization-code server-side; Lane C owns a
separate, frozen `/token` that **subrequests** the provider, unwraps the resulting opaque grant, mints a
first-party `whk_` against the existing grant lifecycle (ADR-0019), and returns it.

This is the riskiest assumption in the lane, so A2a proves the spine **as a pure, I/O-free module**
before the second risk (the provider × OpenNext mount, A2b). Every external effect — provider
exchange/unwrap/revoke, the mint, org-membership lookup, the refresh-token store — is an **injected
dependency**, so the security invariants are unit-testable with fakes and the same cores mount unchanged
in A2b. Proving it here also lets us **freeze two contracts now**, while their shape is still soft: the
C↔D `/token` response body (Lane D depends on it) and the dependency-seam interfaces (A2b implements
them).

## decision

**1. Option-B "two token endpoints."** The provider owns DCR / discovery / its server-side
`/oauth/token`; Lane C owns the frozen `/token`. `redeemAuthCode` is the auth-code half;
`redeemRefresh` is the silent re-mint. The provider's opaque token never reaches the client.

**2. The frozen `/token` body (the C↔D contract).** Exactly: `{ access_token: "whk_…", token_type:
"Bearer", expires_in, refresh_token, scope (space-joined), resource }`. `refresh_token` is Lane C's own
opaque ~90d handle (stored hashed, bound to the Lane C grant), **not** the provider's refresh.

**3. The mint invariants (enforced in the core, proven by tests):**
- **Audience comes only from consent.** `redeemAuthCode` takes the audience from the consent-recorded
  `props.audience` (never the request body); `redeemRefresh` takes it from the grant's stored audience.
  Both assert it is one of `allowedAudiences` (`{API_RESOURCE, MCP_RESOURCE}`) and non-blank, else
  `invalid_target`. (Audience confusion = a token meant for mcp. accepted at api.)
- **Scope can only narrow, on both paths.** First issuance mints `props.scopes ∩ allowedScopes`
  (defense-in-depth even though consent already intersected); refresh mints `requested ∩ grant-consented
  ∩ allowedScopes` where *grant-consented* is read from the grant's child `api_keys` rows. An empty
  result is rejected (`invalid_scope`), never minted blank. Scopes are de-duplicated.
- **Tenancy bind.** `redeemAuthCode` rejects (`access_denied`) unless the consenting user is a member of
  the grant's org before minting.
- **Refresh single-use, consume-before-mint.** The presented refresh token is **atomically consumed**
  (marked used + replacement emitted) *before* the mint via one `consumeRefresh` seam; a concurrent
  replay loses the race, gets `null`, and can never mint a second key. (This replaces the unsafe
  lookup-then-rotate-after-mint ordering.)
- **Provider-grant revocation is best-effort, after the client artifacts exist.** Order is mint →
  issue-refresh → revoke-provider-grant. If the refresh can't be issued, the just-minted key is rolled
  back (`rollbackMint`) and the call returns `server_error` — nothing is orphaned. If the provider-grant
  revoke fails, the call **still returns the token** (the opaque token was never delivered to the client)
  and logs `issuer.provider_grant_revoke_failed` with `reapRequired` for later cleanup — failing the
  request here would orphan the client's just-issued credentials.
- **No token material is ever logged or echoed.** Logs carry only ids (`grantId`/`keyId`/`audience`/
  `scopeCount`); errors use canned descriptions — the provider's free-text error description is **not**
  forwarded to the client.

**4. This is where Lane C honors ADR-0019's A0c subset contract.** ADR-0019 documents that
`mintKeyForGrant` *cannot* verify a refresh stays within the grant's original consent ("a widening
refresh would escalate") — it is the **caller's** duty. `redeemRefresh`'s `requested ∩ grant-consented ∩
allowedScopes` intersection is that duty discharged, at the Lane C layer.

## rejected alternatives

- **A single `/token` that returns a `whk_`** — impossible; the provider claims `tokenEndpoint` with no
  body hook (verified in the library source). Hence Option B.
- **Refresh = lookup then rotate after the mint** — leaves a window where a concurrent replay mints N
  keys from one single-use token. Consume-before-mint closes it.
- **Mint `props.scopes` / the request scope raw** — no defense-in-depth; an upstream consent bug or a
  widening refresh would escalate. Always intersect against capability (and, on refresh, the grant's
  consented set).
- **Fail the whole request when the provider-grant revoke fails** — orphans the client's just-minted,
  already-delivered `whk_` + refresh. Best-effort + reap-log is the safer trade (the opaque token was
  never delivered).
- **Forward the provider's error `description`** — may leak internal detail; map to a canned string.

## consequences

- **Two contracts are now frozen.** The C↔D `/token` body (Lane D's `wbhk` login/refresh consume it) and
  the `AuthCodeDeps`/`RefreshDeps` injected-seam interfaces (A2b implements them: `exchangeAuthCode`/
  `unwrapToken`/`revokeProviderGrant` over the provider; `mintScopedKey`/`mintKeyForGrant`/
  `listGrantScopes`/`isOrgMember` over Lane B; `issueRefreshToken`/`consumeRefresh`/`rollbackMint` over a
  hashed refresh-token store).
- **Single-use rotation has an accepted availability trade.** Because `consumeRefresh` burns the token
  first, a refresh request that fails a later check (or whose mint throws transiently) loses its refresh
  token → re-login. This is inherent to single-use rotation; the no-double-mint security win dominates.
- **A2b carries the real-seam follow-ups (flagged):** (a) `consumeRefresh` must be a genuinely atomic
  SQL `UPDATE … RETURNING` (the pure-core test proves single-use *semantics* sequentially; true
  concurrency is an A2b integration test); (b) decide whether the provider grant is revoked or retained
  on the `pending_approval` path (dormant in v1 — approval defaults off, ADR-0019 A0c); (c) `rollbackMint`
  maps to `revokeGrant`; (d) the provider × OpenNext mount itself.
- **Tested** (pure-logic, no DB, `apps/auth/src/issuer/token-core.test.ts`, 25 cases): the happy auth-code
  + refresh frozen bodies; audience taken from consent/grant and never the request, rejected when
  disallowed/blank; scope intersection + dedup + empty-rejection on both paths; tenancy reject; provider
  grant revoked after mint and **not** before a successful mint; refresh consumed exactly once before
  minting (replay → `invalid_grant`, no second mint); partial-failure compensation (refresh-issue failure
  → rollback + `server_error`; revoke failure → token still returned + reap-log); provider error code
  propagated but its description not forwarded; no token material (access/refresh/code/verifier/opaque) in
  any log on any path.
