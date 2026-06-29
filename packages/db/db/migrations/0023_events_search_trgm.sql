-- migrate:up

-- Trigram GIN indexes backing the events.list `filter.search` substring search (Slice 1c). The search
-- is `provider_event_id / external_id / dedup_key ILIKE '%term%'` (+ an exact id match when the term is a
-- uuid). A plain btree can't serve a leading-wildcard ILIKE, so substring search on a large endpoint
-- would otherwise scan the whole endpoint partition; pg_trgm + a per-column GIN makes `%term%` index-able.
--
-- pg_trgm is a TRUSTED extension (PG13+), so the migration role (a non-superuser with CREATE on the DB)
-- may create it; `if not exists` keeps it idempotent.
--
-- ⚠️ Hot-path write-amplification: GIN indexes add per-INSERT maintenance on the events ingest table. The
-- per-column GINs are on the (nullable) ID columns only; GIN's default fastupdate buffers most of the cost
-- on the pending list. Index order across the OR is resolved by the planner via BitmapOr of the per-column
-- trigram scans, then BitmapAnd with the endpoint_id btree (events_tunnel_idx). Validated with EXPLAIN
-- against seeded volume during build (see the PR). Plain CREATE INDEX (not CONCURRENTLY): the events table
-- is small at apply time → instant build; a large future table would want CONCURRENTLY + transaction:false.
create extension if not exists pg_trgm;
create index events_provider_event_id_trgm on events using gin (provider_event_id gin_trgm_ops);
create index events_external_id_trgm on events using gin (external_id gin_trgm_ops);
create index events_dedup_key_trgm on events using gin (dedup_key gin_trgm_ops);

-- migrate:down

-- Drop only the indexes this migration added; leave pg_trgm in place (dropping a shared extension on a
-- feature rollback is unsafe if anything else comes to depend on it, and re-`create extension if not
-- exists` on a later up is a harmless no-op).
drop index if exists events_dedup_key_trgm;
drop index if exists events_external_id_trgm;
drop index if exists events_provider_event_id_trgm;
