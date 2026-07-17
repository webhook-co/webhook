-- migrate:up

-- Drop the trigram GIN on a column that is NEVER WRITTEN.
--
-- `events.external_id` has been bound `null::text` unconditionally since ingest existed
-- (packages/db/src/ingest-event.ts). So this index has indexed nothing, can match nothing, and has paid
-- per-INSERT GIN maintenance on the highest-volume table in the schema for its entire life.
--
-- The column STAYS. The design record is explicit about what it is — internal build plan:
--   "events(endpoint_id, dedup_key) unique — the idempotency gate (replaces v1's (endpoint_id, external_id))"
--   "external_id is retained nullable for human correlation only."
-- i.e. it is v1's superseded idempotency key, kept as an informational field. It is NOT the Standard Webhooks
-- `webhook-id` that a code comment guessed at — that guess is what made a dead branch look like a feature.
-- Nothing populates it because no inbound source was ever designed to; wiring one is a real capability with
-- its own ADR, not a side effect of an events page.
--
-- The matching `external_id ilike` branch is removed from eventSearchFilter in the same change: a search
-- branch that cannot match is not a capability, and keeping it forced the disjunction to stay unindexable.
--
-- Plain DROP INDEX (not CONCURRENTLY), matching the 0022/0023/0036/0089 convention: prod is at baseline
-- volume, so HOLDING the ACCESS EXCLUSIVE lock is a non-event — the drop itself is near-instant.
--
-- ACQUIRING it is the part worth bounding, and it is not the same question. DROP INDEX must wait for every
-- in-flight reader of `events` to finish, and while it WAITS it queues ahead of everything behind it — so a
-- single slow browse would park the drop, and the drop would then park ingest INSERTs behind itself. At
-- webhook_ingest's 5s statement_timeout (0006), a parked INSERT is a DROPPED WEBHOOK. That is a strange way
-- to lose a customer's event: deleting an index nobody uses.
--
-- lock_timeout bounds only the WAIT. If the lock isn't free within 2s this migration fails loudly and is
-- re-run, which is the cheap outcome; without it, the failure mode is silent and lands on ingest. `set local`
-- scopes it to this migration's transaction (dbmate wraps each file in one), so it reverts at commit and
-- cannot leak onto the connection.
set local lock_timeout = '2s';

drop index events_external_id_trgm;

-- migrate:down

create index events_external_id_trgm on events using gin (external_id gin_trgm_ops);
