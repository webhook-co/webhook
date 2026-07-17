-- migrate:up

-- The ORG-WIDE events browse (events.list with no endpointId — the consolidated /org/{slug}/events page).
--
-- Migration 0036 said "events needs NO new index: events.list/tail keyset on endpoint_id + received_at,
-- already covered by events_tunnel_idx". That was true, and stays true, for the ENDPOINT-scoped browse. It
-- does not hold once endpointId is optional: under RLS the org-wide read is
--   `org_id = current_org_id() and deleted_at is null ORDER BY received_at DESC, id DESC`
-- and 0003's events_org_recent_idx (org_id, received_at desc) lacks the `id` tiebreaker, so it cannot serve
-- the keyset seek `(received_at, id) < (…, …)` and forces a Sort node.
--
-- This index SUBSUMES events_org_recent_idx (same leading columns + the tiebreaker, no predicate), so 0003's
-- is dropped rather than left as dead write-amp on the highest-volume table in the schema.
--
-- DELIBERATELY NOT PARTIAL on `deleted_at is null`, unlike the endpoints_org_ordered_idx precedent in 0036.
-- Two readers need to see tombstoned rows and a partial index would silently stop serving them:
--   * retention.ts listExpiringEvents — `org_id = $1 and received_at < …` as webhook_retention, which MUST
--     see tombstones to hard-delete them (event-payload-purge.ts:39). webhook_retention isn't even granted
--     the deleted_at column (0053:49), so it could never satisfy a `deleted_at is null` predicate.
--   * period-usage.ts's soft-cap count(*), which omits deleted_at on purpose — 0058: a tombstone is still a
--     billed event.
-- Measured on a seeded db: the steady-state retention listing is 0.27ms on this index vs 118ms on a Parallel
-- Seq Scan without it.
--
-- Ascending columns match the 0036 convention: a backward index scan serves the DESC browse with no Sort.
create index events_org_ordered_idx on events (org_id, received_at, id);
drop index events_org_recent_idx;

-- The org-wide `verificationState = failed` filter. events_failed_idx (0022) leads with endpoint_id, so it
-- cannot serve an org-wide failed-filter; without this, `?status=failed` on an org with few failures walks the
-- org's entire history as a residual — the exact scan 0022 exists to prevent, one scope wider. The predicate
-- mirrors verificationStatePredicate("failed") in reads.ts EXACTLY so the planner can prove it. Sparse by
-- construction (only a genuine signature failure sets verification with verified=false), so it stays small
-- and a non-matching insert pays only the predicate check.
create index events_org_failed_idx on events (org_id, received_at, id)
  where verification is not null and not verified;

-- UNRELATED TO THE BROWSE, and the only index here that fixes a bug live in production right now.
--
-- period-usage.ts's soft-cap total counts billable delivery dispatches:
--   `select count(*) from delivery_attempts where created_at >= $1 and (…) and billable`
-- 0055 added `billable` with NO index, and delivery_attempts_org_ordered_idx (0036) covers only
-- (org_id, created_at, id) — so `billable` is a residual requiring a HEAP FETCH for every candidate row, and
-- the count can never be index-only. delivery_attempts rows are wide; at ~1M dispatches/day this is seconds.
--
-- That query backs BOTH readUsageSummary (the billing surface) and runCapProducer (the enforcement path), so
-- today the Free-tier soft cap FAILS OPEN under exactly the load that should trip it. Partial + index-only:
-- the cap only ever counts billable rows, so indexing the others would be write-amp for nothing.
create index delivery_attempts_org_billable_idx on delivery_attempts (org_id, created_at)
  where billable;

-- Plain CREATE INDEX (not CONCURRENTLY), matching the 0022/0023/0025/0031/0036 convention: prod is at
-- baseline volume, so the build is instant and the brief SHARE lock is a non-event. Revisit if `events` grows
-- materially before this is applied — 0036's header documents that path (one index per `transaction:false`
-- file, because dbmate runs such a body as ONE multi-statement query and Postgres forbids CONCURRENTLY there).

-- migrate:down

drop index if exists delivery_attempts_org_billable_idx;
drop index if exists events_org_failed_idx;
drop index if exists events_org_ordered_idx;
create index events_org_recent_idx on events (org_id, received_at desc);
