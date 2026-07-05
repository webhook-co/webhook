-- migrate:up

-- Supporting index for the per-org, windowed COUNT the ingest-URL reveal rate limiter runs
-- (S8-remainder Slice 2a / ADR-0101): `select count(*) from audit_log where action = $1 and created_at >
-- now() - <window>` under the org's RLS (org_id = current_org_id()). Without it, every reveal scans the
-- org's ENTIRE audit partition via the (org_id, seq) unique index and filters action + created_at in memory
-- — latency that grows with audit history on a hot path. This mirrors the sibling auth_audit_event table,
-- which added exactly `(org_id, event_type, created_at desc)` for the identical count-in-a-window pattern
-- (migration 0013). audit_log has org_id as the RLS-scoping column (leading), the action equality, then the
-- created_at range (DESC to match the recency window), so the COUNT is served index-only.
--
-- Plain CREATE INDEX (not CONCURRENTLY): audit_log is modest at this stage and the build is sub-second, so
-- the brief lock is negligible — the same posture as the 0036 covering indexes. (A large-table build would
-- want CONCURRENTLY in a `transaction:false` migration; not warranted here.)
create index audit_log_org_action_created_idx on audit_log (org_id, action, created_at desc);

-- migrate:down
drop index audit_log_org_action_created_idx;
