# ADR 0092 — replay-destinations dashboard: the web seal binding + allowlist management surface

> renumbered from 0091 (the S7 TypeScript-SDK slice, #350, claimed 0091 on main first).

- status: accepted
- date: 2026-07-04
- scope: `apps/web`, `scripts/gen-wrangler-prod.mjs`, `packages/db` (exports only)
- review severity: high (SSRF-egress allowlist mutation + a secret-sealing path + a new web→engine binding)

## context

The `replayDestinations.*` capability family (create / list / delete / enable / setOrdered /
rotateSigningSecret / listSigningSecrets — ADR-0081) and its per-destination signing keys (ADR-0084)
shipped bound on CLI/API but `WEB_DEFERRED` on the dashboard (and deliberately `mcp`-exempt: an agent must
never mutate the SSRF-egress allowlist — confused-deputy, ADR-0005). This ADR records the decisions made
building that deferred web surface — the second slice of the S1 dashboard-gaps lane. It is a **trust
surface**: the allowlist is the pre-registered set of public https URLs the delivery engine is permitted to
egress to, and creating/rotating a destination mints a Standard-Webhooks signing secret.

## decision

### 1. The web worker gains a seal-only `PROVIDER_SECRET_SEALER` service binding

Creating a destination mints its first signing secret, and rotating mints a fresh one; both seal the
plaintext under the KMS envelope. The KEK lives **only in the engine**, exposed as the seal-only
`ProviderSecretSealer` WorkerEntrypoint (`sealString` — no unseal method exists). The dashboard mirrors
api/mcp: a `PROVIDER_SECRET_SEALER` web→engine service binding, injected **only at deploy** by the overlay
generator (`gen-wrangler-prod.mjs` `web.services`), **never committed** to `apps/web/wrangler.jsonc`. The
binding is **write-only** — it cannot decrypt anything, so binding it into the web worker is strictly weaker
than the secrets (session signer, pepper, audit key) the worker already holds. `getProviderSecretSealer()`
detects it **structurally** (an object with a `sealString` method) so a mis-shaped binding never masquerades
as a working sealer; it is `undefined` in dev/preview/pre-provision.

### 2. Fail closed — never store a destination without a real sealed secret

If the sealer binding is absent, a create/rotate **throws** (`SealerUnavailableError`) rather than
proceeding. A destination is never registered with an unsigned/plaintext or absent secret because the
binding happened to be missing. This is enforced in the mutation seam (`requireSealer`), one layer below the
action, so every future caller inherits it.

### 3. Authoritative structural SSRF check at registration time, in the seam

A create URL is canonicalized + structurally validated (`canonicalizeAndValidateUrl` — https-only, no
userinfo, allowed ports, no IP-literal host, FQDN required) in the mutation seam **before any DB write**,
and the canonical form is what's stored (the db fn expects a pre-canonicalized URL). A refusal is surfaced as
**honest, plain-language** copy (`destinationUrlError`) that explains what an allowed target looks like — it
never implies the URL is "malicious" (the check is structural-only). This registration-time reject is the
first of two layers; the engine's connect-time DoH + private-CIDR guard remains the authoritative second
layer at delivery (ADR-0005). We never weaken or duplicate that guard here.

### 4. One-time secret reveal; metadata-only history; nothing leaked

The minted `whsec_` plaintext is returned **once**, only as the action result, and shown in a one-time
reveal dialog (mirroring the endpoint ingest-URL and API-key reveals). It is never SSR'd, persisted beyond
the seal, or logged — `logActionError` receives the error only, never the input or the secret. The signing
-secret history surface (`listSigningSecrets`) returns **metadata only** (id / status / createdAt); the db
read selects no ciphertext/DEK/nonce columns, so sealed bytes and plaintext never leave the DB through it.

### 5. Session + RLS authz; direct db-fn binding (no capability handler map)

Like the endpoints/credentials dashboards, the web surface authenticates a **session** (RLS-org-pinned; any
org member may manage the org's allowlist) and binds the raw Lane db fns directly under `withTenant(orgId)`,
rather than the scope-gated capability handlers (which stay api-only — the pattern that keeps the mcp
exemption un-driftable). No contract change: `surfaceExempt.web` stays as-is, exactly as Slice 1 (deliveries)
did. Two new `@webhook-co/db` leaf subpath exports (`./replay-destinations`, `./signing-keys`) are added
because the `@webhook-co/db` barrel is `undefined` under Turbopack.

### 6. Information architecture — a global "Destinations" surface

A top-level **Destinations** nav section: create (URL + optional label), the whole allowlist (intentionally
un-paginated — a small handful), per-row enable (re-enable an engine auto-disabled destination), a strict
-FIFO `ordered` toggle, rotate signing secret (one-time reveal), and remove (confirm; drops it as a delivery
target + cancels its open deliveries in-tx). There is **no manual disable** — the capability family has none
(the engine auto-disables on persistent failure; the operator re-enables).

## verification

The seal binding carries no committed config and no unit test (the overlay generator is validated by the CD
dry-run, exactly as `AUTH_SESSION_EXCHANGE` was added — ADR n/a). It is verified **end-to-end in prod**: the
create + rotate flows exercise the real web→engine seal RPC; a delivered replay whose `webhook-signature`
recomputes against the revealed secret confirms the sealed key round-trips. Pure/security logic (fail-closed
sealer, canonicalize-before-write, honest copy, leakage) is unit-tested with injected seams.

## consequences

- Slice 4 (provider-secret form) reuses this same `PROVIDER_SECRET_SEALER` web binding — no further wrangler
  or overlay change is needed there.
- The dashboard now mutates the SSRF-egress allowlist; the engine egress guard remains the authoritative
  defense — this surface only pre-registers, it never widens what the engine will connect to at delivery.
