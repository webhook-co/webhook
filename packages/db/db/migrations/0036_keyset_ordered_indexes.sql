-- migrate:up

-- Covering btree indexes for the keyset-pagination browse reads (deliveries.list + endpoints.list). The reads
-- moved from ordering on `date_trunc('milliseconds', <col>)` — a STABLE expression no index can serve — to the
-- RAW `<col>` at full microsecond precision (the opaque cursor now carries exact µs; see packages/shared
-- cursor.ts + packages/db reads.ts). A plain `(equality-col, <col>, id)` btree now serves both the ORDER BY
-- (a backward scan for the DESC browse) and the keyset seek, with no Sort node.
--
-- events needs NO new index: events.list/tail keyset on `endpoint_id` + `received_at`, already covered by
-- events_tunnel_idx (endpoint_id, received_at, id) once the date_trunc wrapper is gone.
--
-- Plain CREATE INDEX (not CONCURRENTLY): these tables are near-empty at apply time, so the build is instant
-- and the brief SHARE lock is a non-event — matching the repo's 0022/0023/0025/0031 convention. A future large
-- table would want `CREATE INDEX CONCURRENTLY` in a `-- migrate:up transaction:false` migration; note dbmate
-- runs a transaction:false body as ONE multi-statement query (Postgres wraps multiple statements in an implicit
-- transaction, which CONCURRENTLY forbids), so that path needs ONE index per migration file. Drop = reverse.

-- deliveries.list, org-wide browse (no filter): RLS adds `org_id = current_org_id()` (a scan key), then
-- ORDER BY created_at DESC, id DESC. No existing index leads with org_id + created_at.
create index delivery_attempts_org_ordered_idx
  on delivery_attempts (org_id, created_at, id);

-- deliveries.list, destination-filtered (all statuses): the existing delivery_attempts_ordered_idx is PARTIAL
-- (status in ('queued','pending')) so it can't serve a full-history browse; delivery_attempts_destination_idx
-- is (destination_id) only, no ordering.
create index delivery_attempts_destination_ordered_idx
  on delivery_attempts (destination_id, created_at, id);

-- deliveries.list, subscription-filtered: subscription_id is nullable (manual replays carry none). `col = const`
-- implies `col is not null`, so the planner uses this partial; keeping it partial keeps it small.
create index delivery_attempts_subscription_ordered_idx
  on delivery_attempts (subscription_id, created_at, id)
  where subscription_id is not null;

-- endpoints.list browse: WHERE deleted_at is null (literal, ADR-0076) under RLS org_id = current_org_id(),
-- ORDER BY created_at DESC, id DESC. Partial matches the query's deleted_at predicate.
create index endpoints_org_ordered_idx
  on endpoints (org_id, created_at, id)
  where deleted_at is null;

-- migrate:down

drop index if exists endpoints_org_ordered_idx;
drop index if exists delivery_attempts_subscription_ordered_idx;
drop index if exists delivery_attempts_destination_ordered_idx;
drop index if exists delivery_attempts_org_ordered_idx;
