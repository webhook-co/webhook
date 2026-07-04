# ADR 0097 — shared provider-secret registration core + single-sourced shape validation/serialization

- status: accepted
- date: 2026-07-04
- scope: `packages/webhooks-spec`, `packages/contract`, `packages/db`, `apps/api`, `apps/mcp`
- review severity: high (a corruption-critical serialization + a control-plane write path that seals secrets)

## context

`endpoints.addProviderSecret` (register an inbound-verification secret) shipped bound on CLI/API/MCP but
`WEB_DEFERRED`. Building the deferred web surface (S1 dashboard-gaps lane, slice 4) requires the web tier to
register a provider secret **identically** to api/mcp — but two pieces of security-critical logic lived only
in the api write-handler and would have to be duplicated (and could drift):

1. the `(provider, kind, secret)` **shape validation** (the contract `.superRefine`), and
2. the `kind → typed-blob` **serialization** — `verify_token` / `braintree_public_key` are wrapped as the
   typed JSON blob the engine's pre-capture handshake recognizes; a `signing_secret` is stored as-is. The
   low-level `addProviderSecret` seals whatever plaintext it is handed, so handing it a **raw** `{secret,kind}`
   would store a verify_token / braintree secret unwrapped → the engine's `parse*` returns null → the secret
   verifies as NO_MATCHING_KEY **forever** (indistinguishable from "no secret"). This is the load-bearing risk.

## decision

### 1. Single-source the shape validation + serialization in webhooks-spec

`validateProviderSecretShape({provider,kind,secret}) → {ok}|{ok:false,path,message}` (pure, zod-free) and
`serializeProviderSecretPlaintext(kind,secret) → string` live in `@webhook-co/webhooks-spec` (re-exported via
`@webhook-co/shared`, the established pattern). The contract `.superRefine` delegates to the validator
(translating a failure to `ctx.addIssue`); the shared db core delegates to both. Behavior-preserving (the
contract's verbatim messages/paths are retained). The serialization is **round-trip tested** — serialize →
`parse*` recovers the original, and the raw value explicitly does **not** parse (the exact corruption guarded
against).

### 2. A shared `registerProviderSecret` write core in packages/db

`registerProviderSecret(app, {orgId,endpointId,provider,kind,secret,label?}, {sealer,evict,auditKey,actor})`
is the ONE write path both the api/mcp capability handler and the web dashboard action call, so the canonical
order can't drift:

  **validate the full input FIRST** — base constraints (provider ∈ PROVIDERS, kind ∈ the 3-value enum,
  secret 1..4096, label ≤200) + the per-kind shape (`validateProviderSecretShape`), all `VALIDATION_ERROR`
  — then resolve endpoint (**NOT_FOUND before any seal**) → **per-endpoint cap** (`RATE_LIMITED`) →
  `serializeProviderSecretPlaintext` by kind → `addProviderSecret` (seal + insert + in-tx audit) → best-effort
  KV evict (**wrapped in a catch** — the secret is already durably committed, so a transient evict failure must
  never throw and induce a duplicate-storing retry).

Validation runs **before** the endpoint lookup (matching the api/mcp handler's safeParse-first precedence, so
the same input yields the same error code on every surface and a bad input never reveals endpoint existence
pre-validation), and the core enforces the SAME base constraints the contract zod does — because it is the
sole input gate on the zod-less web path, not merely a shape refine. It throws typed `CapabilityFault`s
(`packages/db` already imports `CapabilityFault` via `write-handlers`).
The api/mcp `endpoints.addProviderSecret` handler is refactored to just safeParse + delegate; its inline
NOT_FOUND gate, serialization, and evict move into the core. **api/mcp behavior is unchanged** — their test
suites (api 134, mcp 92) passing unmodified is the no-drift proof.

### 3. Enforce the previously-unenforced per-endpoint cap

`RATE_LIMITED` was declared on all three provider-secret capabilities but nothing enforced it.
`MAX_PROVIDER_SECRETS_PER_ENDPOINT = 25` (a shared constant) + `countLiveProviderSecrets` (active + retiring)
enforce it in the shared core, so **every** surface (api/mcp now, web next) inherits one guardrail value. A
tiny check-then-insert race (like the endpoints-per-org cap) can transiently yield cap+1 — a benign
guardrail, not a security boundary.

### 4. Web-ready leaf export; no new infra

A `@webhook-co/db/provider-secrets` leaf subpath export is added (the web bundle imports leaf subpaths — the
barrel is `undefined` under Turbopack). The web tier (slice 4b) will call `registerProviderSecret` reusing the
**already-live** `PROVIDER_SECRET_SEALER` binding (ADR-0092) + the web-bound `AUDIT_CHAIN_HMAC_KEY` — **no new
binding**.

## consequences

- The corruption-critical serialization now has exactly one implementation, round-trip tested; a future SW/
  verify-token/braintree change updates one place.
- api/mcp gain the per-endpoint cap (a new, intended enforcement of the declared `RATE_LIMITED`).
- Slice 4b (the web panel) is a thin consumer of this core — no further backend change.
