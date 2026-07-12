-- migrate:up

-- Btree index on events.payload_r2_key backing the orphan-sweep anti-join (S6c-iii): the hourly sweep asks
-- "which of this page of R2 object keys have an events row?" via `where payload_r2_key in (…up to 1000…)`.
-- Without this index that probe is a SEQ SCAN of events on the SAME Neon compute the ingest (revenue) path
-- writes to — an hourly full scan that would pressure ingest INSERTs at scale. The index makes it an index
-- scan. payload_r2_key is effectively unique per stored body (content-addressed), so selectivity is high.
--
-- A plain CREATE INDEX (not CONCURRENTLY) is correct here: the events table is small at apply time, so the
-- build is effectively instant, and an index is derived data (no backfill). Were this table already large in
-- a future environment, this would want CREATE INDEX CONCURRENTLY + transaction:false.
create index events_payload_r2_key_idx on events (payload_r2_key);

-- migrate:down
drop index if exists events_payload_r2_key_idx;
