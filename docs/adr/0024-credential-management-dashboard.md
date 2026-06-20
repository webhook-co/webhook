# ADR 0024 — the credential-management dashboard (read · create · revoke)

- status: accepted
- date: 2026-06-20
- scope: `apps/web` (`settings/credentials`)
- relates: [ADR-0019](0019-credential-mint-model.md) (the first-party `api_keys` mint model) and
  [ADR-0020](0020-credential-governance-schema.md) (the grant/audit schema) — Lane B's server side that this
  UI consumes; [ADR-0023](0023-app-session-gate-dal.md) (the DAL gate every action here calls); the Lane E
  build-plan (`internal/build-plans/lane-e-auth-frontend.md`, slice E6); internal auth ADR-0010 round 7.

## context

The dashboard's only mutating surface in v1 is credential management: list the org's **authorized devices/
grants** and **standalone API keys**, **create** a key (with the one-time secret reveal), and **revoke** a key
or a whole device grant. Per the founder's D-1 call the dashboard owns this same-origin on `app.` — there are
no Lane C credential routes and no cross-origin call to `auth.`. Built across three mock-first slices: E6a (the
read view), E6b (create + reveal), E6c (revoke + grant cascade). The live wiring is E8.

## decision

**E-owned `app.` server actions over Lane B's db functions, mock-first, with a transport-safe reveal and an
optimistic, cascade-aware revoke.**

- **Ownership/topology.** The mutations are `"use server"` actions in `apps/web` (`createApiKey`, `revokeApiKey`,
  `revokeGrant`), each gated first-line by `verifySession()` (ADR-0023). E8 has them call Lane B's
  surface-agnostic db fns directly under `withTenant(session.orgId)` as `webhook_app` — **no Lane C routes, no
  A9, no cross-origin to `auth.`**. The actions are invoked from a `"use client"` `CredentialsManager` that the
  gated server page hands the actions to as props.
- **Mock-first seam.** E6 actions return the same display-only DTO shapes Lane B returns (`ApiKeyItem`/
  `DeviceGrant` — neither ever carries `key_hash`/plaintext). E8 swaps in the live db calls + `KV_AUTHZ`
  eviction + the `key_minted` audit **without touching the UI** — the action signatures are the seam.
- **Transport-safe one-time reveal.** A freshly created key's plaintext is returned **only** as the
  client-invoked action result, held in transient client state, and shown once via `CopyButton`. It is never
  SSR'd into the page / RSC flight / cached HTML, never persisted into the keys list, and is redacted on
  dismiss; thereafter only the redacted `start` prefix shows.
- **Scope narrowing is server-side.** `createApiKey` narrows the requested scopes to the grantable
  `CAPABILITY_SCOPES` (dropping the reserved `keys:manage` and anything unknown). The client scope picker is
  **presentation-only** — it receives the grantable list as a prop (so the client bundle never imports the
  `@webhook-co/contract` registry; see ADR-0019's SoT) and can never widen a key.
- **Revoke: optimistic + cascade.** Revoking a standalone key marks it revoked; revoking a device grant
  **cascades** — the client marks the grant *and every key minted under it* revoked, mirroring Lane B's
  `revokeGrant` (which returns `revokedKeyHashes` for E8 to evict from `KV_AUTHZ`). Revoke is gated behind a
  confirm dialog; the affordance shows only for live credentials (a non-revoked key, an `active` grant —
  device-child keys are revoked via their grant's cascade, never individually). Revoked credentials **stay
  visible** (audit trail) but read as dead.
- **The confirm can't be dismissed mid-flight.** While a revoke is in flight the dialog ignores
  Escape/outside-click, so a failure that lands after a close can't set an error on an already-closed dialog
  and be swallowed.

## the r7 invariant (load-bearing)

Dashboard keys are **first-party `api_keys`** minted/revoked through Lane B's `createApiKey`/`revokeApiKey`
(ADR-0019/0020) — **never** the better-auth `apikey` plugin. The dashboard is one of the credential-issuing
Workers (it holds the pepper + audit key + DB + `KV_AUTHZ` once E8 adds the bindings); RLS via the session
`orgId` is the tenant backstop, so the DAL gate is load-bearing.

## consequences

- E6 ships fully on Lane B (shipped) against mock data + a test org; only the live session `orgId` waits on E7,
  and the live db/KV/audit wiring is E8.
- **E8 obligation (§6 BLOCKER):** `createApiKey` writes **no audit row** today — the live create path must
  compose Lane B's `appendAuthAuditEntry` (`key_minted`) so a mint is never silent (constitution).
- **E8 obligation:** revoke must evict `KV_AUTHZ` (`resolver.invalidateHash`) for the key — and for every
  cascaded key hash on a grant revoke — so a revoked credential stops authenticating immediately.
- The page is dynamic (`ƒ`) — it gates on `cookies()` — and renders no `key_hash`/plaintext by construction.
