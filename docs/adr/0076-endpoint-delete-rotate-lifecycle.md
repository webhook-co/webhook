# ADR 0076 — `endpoints.delete` (soft) + `endpoints.rotate` (hard cutover) + KV ingest-cache eviction

> **Superseded (partial), 2026-06-26.** The *one-time, unrecoverable reveal* of the rotated ingest URL
> described here is superseded by a decision to make the ingest URL **always-shown** — retrievable on demand
> and stored **envelope-encrypted at rest** (not hash-only). Rotate still mints a new token and hard-cuts the
> old one (unchanged); only the "new URL shown exactly once" property changes. Delete/soft-delete semantics
> are unaffected. This ADR will be revised when that change ships (tracked in the internal backlog).

- status: accepted.
- date: 2026-06-25
- scope: server + cli. `packages/contract` (new `endpoints.delete` + `endpoints.rotate` capabilities,
  `DeletedEndpointSchema`; both reuse the existing `endpoints:write` scope — no new scope); `packages/db`
  (`deleteEndpointWithAudit` + `rotateEndpointWithAudit`; the `deleted_at` filter on the ingest cold
  lookup, the per-org create-cap count, and the list/get reads; `makeIngestHashEvictor`; the two new write
  handlers in `createWriteHandlers`, gated on a new optional `invalidateIngestHash` dep); `apps/api`
  (`DELETE /v1/endpoints/:id` + `POST /v1/endpoints/:id/rotate`, generic dispatch; a `KV_CONFIG` binding to
  evict); `apps/mcp` (the auto-registered `endpoints.delete` / `endpoints.rotate` tools; a `KV_CONFIG`
  binding); `packages/cli` (`wbhk endpoints delete` / `wbhk endpoints rotate`, `--yes`-gated). One migration
  (**0021**): `endpoints.deleted_at` + a `select (deleted_at)` grant to `webhook_authn`.
- relates: ADR-0075 (`endpoints.create` + `endpoints:write` — this completes that lifecycle), ADR-0003
  (256-bit credential floor — rotate mints a fresh token), ADR-0004 (`wha1`/`audit_log` chain — the
  `endpoint.deleted` / `endpoint.rotated` rows), ADR-0008 (hash-at-rest, plaintext-shown-once — rotate's
  one-time reveal), ADR-0011/0015 (the ingest KV cache + the `getEndpointIngestTokenHash` →
  `invalidateHash` eviction seam this is the first runtime caller of), ADR-0019 (mint model).
- review severity: high — a destructive op + a token-rotation reveal + a deployed KV-binding change on the
  ingest control plane. `/code-review` + `/security-review`.

## context

`endpoints.create` (ADR-0075) shipped create but left **delete** and **rotate** as tracked follow-ups, and
installed a 100/org create soft-cap explicitly "as an abuse backstop while there is no endpoints.delete
yet". An org could not remove an endpoint, and a leaked or lost `wbhk.my/<token>` ingest URL could only be
abandoned (it kept resolving forever — the endpoints table has no revoke/expiry on the ingest token).

The live `wbhk.my` ingest hot path resolves a presented token to `{org, endpoint, paused}` via a **KV_CONFIG**
cache (engine-only binding) backed by a `webhook_authn` cold lookup, and reads `paused` from the cached
principal — never a live DB query. So a DB-only state change does nothing to live ingest until the KV entry
is evicted or its 300s TTL lapses. The documented eviction seam (`getEndpointIngestTokenHash` →
`resolver.invalidateHash`) existed but had **zero runtime callers** — this lane is the first.

## decision

Two capabilities, both gated by the existing **`endpoints:write`** scope (no new scope), bound on
**api + cli + mcp** at parity (web deferred with the dashboard). Everything derives from the contract
descriptors.

1. **`endpoints.delete` = SOFT delete.** A new nullable `endpoints.deleted_at` (migration 0021) marks an
   endpoint deleted; the row, its captured events, its R2 payload bodies, and its audit history are
   **retained** (webhook.co's wedge is payload inspection; a hard cascade would destroy event history and
   orphan R2 bodies, of which there is no prune sweep — and would conflict with retaining the chain for
   compliance reads). Three query seams filter `deleted_at is null`:
   - the **ingest cold lookup** (`makeEndpointTokenColdLookup`) — the DURABLE stop: a deleted endpoint's
     token resolves to no row, so ingest 404s, and the system self-heals within the KV TTL even if an
     eviction is missed. (Without this filter, the next cold miss would re-cache the still-present row,
     undoing the eviction — the single most important correctness point.)
   - the **per-org create-cap count** — so a delete actually relieves the 100/org cap (the lane's purpose).
   - **`endpoints.list` / `endpoints.get`** — a deleted endpoint is hidden from the endpoint read
     surfaces. (The EVENT handlers — events.list / events.tail / events.replay — resolve the endpoint with
     an explicit `includeDeleted` flag for their existence/ownership gate, so a deleted endpoint's
     captured events stay listable / tailable / replayable by id: the inspection-history retention soft
     delete was chosen for. `getEndpoint` defaults to the filtered behaviour for `endpoints.get`.)

   **`webhook_authn` holds a COLUMN-scoped SELECT grant** on endpoints (migration 0011:
   `id, org_id, ingest_token_hash, paused`), so migration 0021 MUST also `grant select (deleted_at)` to it
   — otherwise the cold-lookup filter would 500 every ingest cold miss with "permission denied for column
   deleted_at" (a hot-path outage). This is the load-bearing migration detail.

   Delete is **idempotent**: a single statement (`update … set deleted_at = coalesce(deleted_at, now())`
   in a CTE that captures the prior `deleted_at`) returns the recorded `deletedAt` and only appends ONE
   `endpoint.deleted` audit row on the actual state transition; an unknown / cross-org id is RLS-invisible
   → `NOT_FOUND` (404). A hard-purge / retention sweep (DB cascade + R2 reconcile + GDPR-style erasure) is
   a deferred follow-up — soft delete is the v1 lifecycle.

2. **`endpoints.rotate` = HARD cutover.** Rotate mints a fresh ingest token, swaps
   `endpoints.ingest_token_hash` in place (under a `for update` row lock that serializes concurrent
   rotate/delete), and returns the new one-time `ingestUrl` (the same reveal shape as create). The old
   token dies immediately — evicted from KV, and after the swap its hash matches no row, so even a missed
   eviction lets it die on the next cold miss / within the TTL. The endpoint id, name, paused state,
   captured events, and provider secrets are **preserved** (unlike delete+recreate, which would cascade
   them away and re-mint anyway). This is the leaked/lost-webhook-URL precedent: the path token IS the
   secret, so keeping the old token alive (a Stripe/Svix-style dual-secret grace window) would defeat the
   purpose — that pattern is for OUTBOUND signing-secret rolls. Rotate is NOT idempotent (each call mints
   a new token; the api-client never blind-retries it), exactly like create. An audit row
   (`endpoint.rotated`) is appended in the same tx. A grace-window variant (a `prev_ingest_token_hash`
   column or an `active|retiring|revoked` token child table + a revoke verb + a sweep, mirroring
   `provider_secrets`) is a deferred follow-up, not v1.

3. **Eviction: bind the engine's `KV_CONFIG` into api + mcp.** The write handlers run on api/mcp, which
   previously bound only `KV_AUTHZ`. They now also bind `KV_CONFIG` (the same namespace by id — KV is
   global-by-id; the prod overlay injects the existing `KV_CONFIG_ID` repo var, so no new infra var) and,
   after a committed delete/rotate, call `makeIngestHashEvictor` to delete `credentialCacheKey(hash)` — the
   exact bare-hex key the ingest resolver caches the principal under, so the eviction hits precisely the
   engine's entry. Eviction is **best-effort**: it runs after the DB commit, and both verbs are
   self-healing without it (delete via the `deleted_at` filter; rotate via the hash mismatch) within the
   300s TTL — so a transient KV error is logged, never thrown (a throw on rotate would lose the one-time
   URL reveal). The alternative (a service-binding RPC to the engine so it could also purge R2 at delete
   time) was rejected for v1: it adds a new engine mutation surface, and soft delete has no R2 to purge.

4. **Audit: `wha1`/`audit_log`, free-text actions, in the same transaction.** `audit_log.action` is
   `text not null` with no enum/CHECK, so `endpoint.deleted` / `endpoint.rotated` need no migration; each is
   appended in the same `withTenant` tx as the mutation (the `createEndpointWithAudit` template). `aae1`
   was not used (it is the auth chain and would need a CHECK-enum migration).

5. **CLI confirmation.** `wbhk endpoints delete` / `rotate` require `--yes` to proceed; in an interactive
   TTY without `--yes` the user must type `yes` (prompted on stderr); in a non-TTY without `--yes` they
   refuse (a usage error, exit 2) so a script can't destroy or rotate an endpoint by accident. Rotate
   reveals the new URL on stdout with the "save it now / the previous url has stopped working" caveat on
   stderr (pipe-safe, mirroring create). MCP has no `--yes` analogue — the scope IS the gate (an agent with
   `endpoints:write` can already mint permanent secret URLs via create), so the tools are bound at parity
   with DESTRUCTIVE descriptions rather than made mcp-exempt.

## alternatives considered

- **Hard delete.** Rejected for v1: cascade-destroys captured events + delivery attempts, orphans R2
  payload bodies (no FK, no sweep), and is irreversible — hostile to an inspection product. Its genuine
  merit (true data-minimization / erasure) is served by the deferred hard-purge job, which can run on soft
  state. (Audit history survives a hard delete regardless — `audit_log` FKs to `orgs`, not endpoints.)
- **A distinct `endpoints:delete` scope.** Rejected: ADR-0075 designed `endpoints:write` to absorb
  update/pause/delete, the scope is fixed at grant/consent time, and a principal that can create
  secret-bearing URLs is already maximally privileged on endpoints — a separate scope adds a consent chip
  with no security gain.
- **Grace-window rotate.** Deferred: it would avoid silent drops from a still-configured upstream, but for
  a LEAKED URL keeping the old token alive is wrong, and it needs schema + a revoke verb + a sweep. v1 hard
  cutover + a loud CLI warning ships the capability; the grace window is a tracked follow-up.
- **Service-binding RPC to the engine for eviction.** Rejected for v1 (see decision 3).

## consequences

- A `whk_` key (or OAuth grant) carrying `endpoints:write` can now delete + rotate in its own org; a
  read-only key gets 403. The dashboard still has no delete/rotate UI — that is lane S1.
- The 100/org create soft-cap is now genuinely relievable: deleting endpoints frees create slots.
- A deleted endpoint's `wbhk.my` URL stops accepting events (404) once the cold lookup re-evaluates —
  immediately on eviction, otherwise within the 300s KV TTL. A rotated endpoint's OLD URL dies on the same
  bound; the NEW URL resolves immediately. There is a sub-TTL window where a just-evicted entry could be
  served stale by KV's eventual consistency — the same bounded posture as api-key revoke, and acceptable.
- `audit.verify` now records `endpoint.deleted` / `endpoint.rotated` rows for any org that deletes/rotates.
- A deleted endpoint's captured events remain readable + replayable via `events.list` / `events.tail` /
  `events.get` / `events.replay` (the event handlers resolve the endpoint with `includeDeleted`) —
  intentional retention; `endpoints.get` / `endpoints.list` hide the endpoint itself.
- Deleting an org's only endpoint is allowed (re-creation is self-serve via `endpoints.create`).
- DEFERRED (documented, not built): a hard-purge / retention sweep (also the GDPR-erasure path); a
  grace-window rotate; a terminal "endpoint deleted" frame on an active `wbhk listen` tunnel (today the
  tunnel simply goes quiet — soft-delete keeps existing events tailing, but no new events arrive).
- **Deploy ordering (schema-before-code):** migration 0021 (the column + the `webhook_authn` grant) MUST be
  applied to prod BEFORE the engine redeploys with the new cold-lookup filter, or every ingest cold miss
  500s. The migration is purely additive (nullable column, no backfill, additive grant), so it is safe to
  apply ahead of the merge.
