-- migrate:up

-- Partial index backing the sparse events.list `verificationState = failed` filter (Slice 1b). A
-- "failed" event is verified=false with a non-null verification (an adapter ran and REJECTED the
-- signature) — rare relative to verified / unattempted, so without a partial index a failed-filter on a
-- high-volume endpoint would walk the whole endpoint partition, discarding most rows before LIMIT. The
-- verified / unattempted states are NOT sparse, so they ride the existing events_tunnel_idx as a
-- residual filter and need no index. Index order (endpoint_id, received_at desc) matches the
-- newest-first browse so it serves the keyset directly. The predicate mirrors verificationStateFilter()
-- in reads.ts exactly (`not verified and verification is not null`) so the planner can use it.
--
-- A plain CREATE INDEX (not CONCURRENTLY) is correct here: the events table is small at apply time, so
-- the build is effectively instant; an index is derived data, so there is no backfill. (Were this table
-- already large in a future environment, this would want CREATE INDEX CONCURRENTLY + transaction:false.)
create index events_failed_idx on events (endpoint_id, received_at desc)
  where verification is not null and not verified;

-- migrate:down
drop index if exists events_failed_idx;
