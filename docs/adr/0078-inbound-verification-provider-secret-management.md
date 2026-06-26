# ADR 0078 — Inbound webhook verification: provider adapters + the seal-only sealer + the provider-secret management surface

- status: accepted.
- date: 2026-06-26
- scope: server + cli + mcp. Three slices of the inbound-verification lane (S2):
  - **A — adapters** (`packages/webhooks-spec`): the three remaining verify adapters — **Standard
    Webhooks** (base64 MAC over `{id}.{ts}.{body}`, `whsec_`+base64 key, space-delimited `v1,` multi-sig,
    300s skew), **Shopify** (base64 MAC over the verbatim body, UTF-8 client secret), **Slack** (hex MAC
    over `v0:{ts}:{body}`, 300s skew). A null-on-invalid strict `b64ToBytes` (webhooks-spec-only, the
    base64 sibling of `hexToBytes`); the rotation + mutation-probe engine unified into one multi-signature
    `verifyHmacCore` (compute each candidate MAC once, compare against all signatures — O(candidates), not
    O(entries × candidates), so no entry cap and no false-reject); `enforceSkew` (NaN-`now` guarded) and an
    `oversizeBodyFailure` guard extracted shared. Stripe/GitHub unchanged.
  - **B0 — the seal seam** (`apps/engine`, `packages/shared`, `packages/db`): the engine `ProviderSecretSealer`
    `WorkerEntrypoint` exposing **seal only** (`sealString`; no open/unseal) over a Cloudflare service binding,
    plus the narrow write-only `SecretSealer` interface (`SecretStore` satisfies it). `addProviderSecret`
    widened to `SecretSealer`. A `memoizeIsolate` helper de-duplicates the per-isolate verify/seal builders.
  - **B1 — the management surface** (`packages/contract`, `packages/db`, `apps/api`, `apps/mcp`, `packages/cli`):
    three capabilities — `endpoints.addProviderSecret` (secret IN only, never out; `endpoints:write`),
    `endpoints.listProviderSecrets` (metadata page, no ciphertext; `endpoints:read`),
    `endpoints.revokeProviderSecret` (`endpoints:write`) — reusing `ProviderSchema` + the existing scopes (no
    new scope). The db write-handlers seal via the `secretSealer` dep + evict the ingest KV cache on add AND
    revoke; `revokeProviderSecret` tightened to `(orgId, endpointId, secretId)` so the caller's `endpointId`
    is authoritative for eviction; `listEndpointProviderSecrets` SELECTs no ciphertext. The api routes
    (`POST/GET /v1/endpoints/:id/provider-secrets`, `DELETE …/:secretId`), the api-client + three `wbhk
    endpoints {add,list,revoke}-provider-secret` commands (secret read via a no-echo prompt / piped stdin —
    never argv), and the auto-registered mcp tools. The api + mcp service binding (`PROVIDER_SECRET_SEALER` →
    `webhook-engine`/`ProviderSecretSealer`) is deploy-injected by `gen-wrangler-prod.mjs`. **No migration**
    (`provider_secrets` + grants exist from migrations 0003 + 0012).
- relates: ADR-0076 (the `endpoints.*` lifecycle + the `getEndpointIngestTokenHash` → `invalidateHash`
  eviction seam this reuses), ADR-0011 (inbound provider-signature verification — this implements the three
  remaining adapters), ADR-0015 (provider-secret cache invalidation — this is its live wiring: evict on
  add/revoke), ADR-0007/0009 (the KMS envelope + KEK custodian the sealer wraps), ADR-0008 (Standard
  Webhooks contract; sealed-at-rest secrets).
- review severity: high — signature-verification crypto + a KEK-handling seam + a secret-accepting surface +
  two deploy-injected service bindings. `/code-review` + `/security-review` per slice (A, B0, B1).

## context

The verify orchestration, the scheme registry, the typed `verification` diagnostic taxonomy, and the read
contract (`EventSchema.verified` + `verification`) all shipped earlier; only Stripe + GitHub had adapters,
and there was no runtime path to register a per-endpoint signing secret — so every non-Stripe/GitHub event
was captured `verified=false`, and verification was unreachable in production. The DB seal/lifecycle
primitives existed (`packages/db/src/provider-secrets.ts`) but `addProviderSecret` had zero non-test callers
(ADR-0015 deferred the live wiring "to the management surface").

## decision

Ship verification end-to-end in three reviewed slices.

**D1 — the KEK stays in one worker.** api/mcp must seal a secret without being able to UNSEAL it. Rather than
give api/mcp their own `SecretStore` (which would let a compromised api/mcp decrypt every provider secret it
can read via RLS), they delegate sealing to the engine over a service binding. The engine `ProviderSecretSealer`
entrypoint exposes **seal only** — there is deliberately no open/unseal method — so the AWS-KMS custodian and
the unseal capability remain solely in the engine. The binding is worker-to-worker (not public). The returned
`SealedRecord` is a plain structured-clone object, so the binding's RPC stub satisfies the write-only
`SecretSealer` interface directly (no wrapper client needed), mirroring mcp's `AUTH_ISSUER: TokenIntrospector`.

**D2 — full MCP parity.** add/list/revoke are bound on api+cli+mcp (web deferred to the S1 dashboard form).
Agents may set/revoke signing secrets; the surface-uniformity tradeoff was taken over strict least-privilege.
The add tool's plaintext transits the MCP channel — accepted under D2. The DB insert is RLS-gated (`withTenant`),
so a compromised api/mcp still cannot write a cross-tenant row, and the seal RPC has no per-tenant authz by
design (sealing is not a confidentiality breach; the boundary is seal-yes / unseal-no).

**The secret is never echoed.** It is accepted on add, sealed, and stored as ciphertext only; no read
(list/get) ever returns the sealed bytes or the plaintext. `listEndpointProviderSecrets` selects only metadata.

**Eviction on add AND revoke.** Revoke is the security-critical case (ADR-0015): without eviction a signature
made with a revoked secret keeps verifying until the KV TTL. Add evicts too, so a freshly-registered secret is
honored on the next ingest rather than after the TTL. Revoke is endpoint-scoped so the evicted endpoint is
always the right one.

**No entry cap in the multi-sig engine.** An earlier `MAX_SIGNATURE_ENTRIES` cap could silently drop a valid
signature beyond the cap; the O(candidates) engine bounds HMAC work by the (org-controlled) candidate count
regardless of header entry count, so the cap is unnecessary and was removed.

**Registration validation at the schema boundary.** A Standard Webhooks secret must be `whsec_`+base64; a
mis-stored one would otherwise verify as `NO_MATCHING_KEY` forever (indistinguishable from "no secret"). The
check is a contract `superRefine` on the add input — single-sourced so every surface (api/mcp) enforces it
identically — and it uses the SAME decoder the verify path uses (`isUsableStandardWebhooksSecret`, exported
from `webhooks-spec`): registration accepts a secret IFF verification can decode it. That closes the gap
where a value matching the base64 *alphabet* but not valid base64 (e.g. a length ≡ 1 mod 4 paste) would
register yet decode to nothing — an alphabet-only regex would have let it through.

**Control-plane audit on add + revoke.** Both mutations append a tamper-evident `wha1`/audit_log row
(`provider_secret.added` / `provider_secret.revoked`) IN THE SAME tx as the insert/update — parity with the
endpoints lifecycle (`endpoint.created/.deleted/.rotated`). Revoke audits only a real transition (a no-op
revoke of an unknown/already-revoked secret writes nothing). The audit HMAC key comes from the runtime
binding, never the DB role (ADR-0004). The secret id is the audit target; no plaintext/ciphertext is logged.

**The metadata list is not paginated.** An endpoint's provider secrets are a human-managed handful (a couple
active/retiring + the revoked history of rotations), so `listProviderSecrets` returns the whole set at once —
no cursor, no limit. The contract output is `{ items }` (not the `paged(...)` envelope); we don't advertise
pagination the surface doesn't implement.

**Deploy ordering.** The engine entrypoint shipped first (B0), live before B1 adds the api/mcp bindings — and
the bindings are deploy-injected (overlay), never committed, so no Worker references a not-yet-live service
(the `IssuerIntrospect`/`SessionExchange` pattern). Race-free regardless of intra-run deploy order.

## consequences

Inbound webhooks from Stripe, GitHub, Shopify, Slack, and Standard Webhooks are verified once a per-endpoint
secret is registered; a correctly-signed event shows `verified=true` with an `ok` diagnostic, a tampered one
`verified=false` with a typed reason, and a revoke stops honoring the secret immediately. Capture's no-drop
floor is unchanged (verify never throws into the ingest path). Add and revoke each append a `wha1` audit row
(parity with the endpoints lifecycle), so the credential-mutation audit trail has no gap.
