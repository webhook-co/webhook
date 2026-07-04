# ADR 0093 — replay-to-destination dashboard action + the web delivery-dispatcher binding

- status: accepted
- date: 2026-07-04
- scope: `apps/web`, `scripts/gen-wrangler-prod.mjs`, `packages/db` (exports only)
- review severity: high (a guarded-egress delivery path + a new web→engine binding on a session-authed surface)

## context

`events.replay` (ADR-0081) shipped bound on CLI/API but `WEB_DEFERRED` (and mcp-exempt — the replay
allowlist is a confused-deputy surface, ADR-0005). This is Slice 3a of the S1 dashboard-gaps lane: the
dashboard **replay-to-destination action** (the localhost-tunnel target stays CLI-intrinsic; the dashboard
replays only to a pre-registered `replay_destinations` allowlist entry). It follows Slice 2 (the destinations
management surface + the seal binding).

## decision

### 1. The web worker gains a `DELIVERY_DISPATCHER` service binding — the single new infra piece

The actual outbound POST, the **authoritative** connect-time DoH + private-CIDR SSRF guard, and the
Standard-Webhooks re-signing all happen in the engine's `DeliveryDispatcher` WorkerEntrypoint. The dashboard
replay invokes it via a `DELIVERY_DISPATCHER` web→engine service binding, injected **only at deploy** by the
overlay generator (`gen-wrangler-prod.mjs` `web.services`), **never committed** (mirrors api, and the Slice 2
sealer). `getDeliveryDispatcher()` detects it **structurally** (an object with a `deliver` method); the
replay mutation **fails closed** (`DispatcherUnavailableError`) when it's absent — a replay errors rather than
silently no-op'ing. The web worker never fetches a destination itself, so this binding does not widen the
web tier's egress surface.

### 2. The engine-spanning orchestration is REPLICATED in web, at api parity (not shared)

The api's remote-replay orchestration lives in `apps/api/src/remote-replay.ts` — deliberately **not** in
`packages/db` — because it spans an external effect (the engine RPC) between two DB transactions; `packages/db`
stays pure and exposes the granular helpers it composes. That handler is not importable across the app
boundary, so the web tier replicates it (the Slice 2 precedent) in `server/replay-mutations.ts`, calling the
**same** granular `@webhook-co/db` helpers (`getEvent` / `getReplayDestination` / `getActiveSigningSecrets` /
`claimDeliveryAttempt` / `finalizeDeliveryAttempt` / `serializeTarget`) and the same `DeliveryDispatcherRpc`.
Kept branch-for-branch at parity (verified by an audit diffing the two): resolve-under-RLS with one not-found
outcome for a missing event **or** destination (no cross-org existence oracle) → CLAIM a `pending` row [tx1] →
engine `deliver` with **no DB tx held across the POST** → FINALIZE the real outcome [tx2]. A **fresh
idempotency key** is minted per invocation (ADR-0016). A dispatch throw synthesizes a terminal `failed`
(never leaves the claim `pending`, never rethrows); a finalize failure logs + falls back to the claimed row
stamped with the real outcome (a throw would prompt a retry → a double POST). A `./replay` db leaf export is
added (the barrel is `undefined` under Turbopack).

### 3. Session authz + honest result rendering; sealed ciphertext only

Authz is `verifySession()` + RLS-org-pinning (any org member may replay the org's events) — the session
counterpart of the api's `events:replay` scope gate. `orgId` comes from the session, never client input; both
ids are uuid-guarded. Signing secrets are relayed **sealed** to the engine (which alone unseals to sign); the
plaintext never enters the web worker. The action strips `orgId` from the returned `DeliveryAttempt`. A
replay **resolves** to a `DeliveryAttempt` for `delivered` / `failed` / `blocked` alike — those are real
outcomes, not thrown errors — so the dashboard renders the returned status **honestly** (reusing Slice 1's
`delivery-copy`); it never claims a blanket "success". Only a genuine fault (event/destination gone, engine
binding absent, unexpected) is `{ok:false}`.

## consequences

- No contract or migration change; `deliveries.list`'s `destinationId` filter is already plumbed, so the
  per-destination deliveries embed (Slice 3b) needs no backend work.
- Delivery here is at-least-once (a fresh key per call); receivers dedup by the Standard-Webhooks webhook-id.
  A one-shot dashboard replay is intentional — automatic reconciliation of an in-doubt attempt is the delivery
  engine's lease/DLQ (ADR-0087), not this surface.
- Slice 4 (provider-secret form) is unaffected; it reuses the Slice 2 sealer binding.
- **Open (founder) follow-up:** a manual replay resolves any LIVE (non-deleted) destination and is NOT gated
  on `disabled_at` — matching the api handler exactly (`disabled` pauses the engine's *automatic* delivery
  loop, not an explicit replay; the UI hides disabled rows from the picker as a nicety). Whether a manual
  replay should refuse an auto-disabled destination is a cross-surface (CLI/API/web) product decision, not a
  web-only change — flagged rather than silently diverged.
