# ADR-0123: async org deletion via a `deleting` marker + the webhook_reaper cron

- **Status:** Accepted (foundation; activation gated — see Rollout)
- **Date:** 2026-07-18
- **Relates to:** #665 (follow-up to #635), ADR-0004 (audit chain), ADR-0076 (endpoint soft-delete), the R2
  payload-purge lifecycle (migration 0051)

## Context

Deleting an org's whole Postgres tree synchronously is one unbounded `delete from orgs` cascade over `events`
+ `delivery_attempts`. #635 moved that work off the per-org audit advisory lock and kept it atomic, but it is
still one long synchronous delete: at extreme volume it can exceed the statement/transaction timeout (making
the biggest orgs effectively undeletable — a right-to-erasure concern), and rows ingested during the delete
are swept by the cascade under the lock. The codebase already deletes org **R2 payload bodies** asynchronously
(a durable `org_deletions` job drained by the `webhook_purge` cron); this extends the same shape to the
Postgres rows.

## Decision

**An org delete is REQUESTED synchronously (mark `deleting`) and DRAINED asynchronously by a cron.**

1. **State model — a `deleting` marker on `orgs`, not FK-decoupling.** `orgs.status` gains a third value,
   `deleting` (0083 anticipated exactly this: a CHECK-not-enum "for a future `pending_deletion`"). The
   alternative — decoupling the `events`/`delivery_attempts` cascade FKs like `audit_log` did — was rejected:
   it would break referential integrity used in normal reads (a dangling event would become representable),
   whereas the audit decoupling was justified only because those tables are WORM and must survive the delete.

2. **The sync request (`requestOrgDeletion`), one atomic transaction.** Mark `deleting` (+ `deleting_at`),
   soft-delete the org's endpoints (so ingest 404s at once via the existing `deleted_at is null` cold-lookup —
   ADR-0076, no new grant), append the WORM `org.deleted` audit row, enqueue the R2 purge job, and capture any
   live Stripe subscription cancellation. The audit advisory lock is held only for this small write. A
   `deleting` org VANISHES from every user surface via one choke point — `user_org_directory()` filters it —
   so the UX matches today's instant delete. Idempotent.

3. **The async drain (`webhook_reaper` cron).** An hourly cross-org cron claims `deleting` orgs oldest-first
   and, per org, deletes `events` in bounded chunks per tick (deleting an event cascades its
   `delivery_attempts` — no extra grant, exactly as `webhook_retention` relies on) until exhausted, then drops
   the org row (the small remaining cascade). Idempotent + resumable: a crash leaves the org `deleting` and
   the next tick continues from whatever rows remain — no cursor to persist.

4. **RLS — a RESTRICTIVE status fence.** `webhook_reaper` holds column-scoped SELECT + DELETE on `orgs`/`events`
   only. The base 0003 policies are `to public` and permissive, so a new *permissive* reaper policy could only
   OR more access on, never subtract. The `status = 'deleting'` guard is therefore expressed as RESTRICTIVE
   policies, which AND: the reaper can touch a row only if the base policy allows it (it is the current tenant)
   AND the org is `deleting`. Pinned at a live org via a wrong GUC, the reaper reads and deletes nothing.

## Consequences

- **Extreme-scale deletion no longer times out**, and the ingest-leak is eliminated (ingest is quiesced at
  request time, not chased during the drain).
- A short window exists where the org is `deleting` but not yet physically gone — invisible to users, the same
  shape as the R2 payload purge that already lingers post-delete.
- `deleteOrgWithAudit` (the #635 synchronous delete) stays in the tree until the callers are flipped; it is the
  fallback while the reaper is dark.

## Rollout (activation is gated)

The foundation ships INERT — nothing marks orgs `deleting` and the cron is dark. Activation sequence:

1. Provision the `webhook_reaper` Neon role + its `HYPERDRIVE_REAPER` pool (caching off); set the
   `HYPERDRIVE_REAPER_ID` GH var (the wrangler overlay then keeps the binding; the cron un-darkens).
2. Verify the cron drains a test `deleting` org in prod.
3. Flip the web delete actions from `deleteOrgWithAudit` to `requestOrgDeletion`, then retire the synchronous
   path.
