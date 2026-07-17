-- Make a redelivery distinguishable from data loss.
--
-- WHY: after the idempotency proof (2026-07-17), a redelivered report left a row reading
-- status='parsed' with ZERO linked aggregate_report rows -- byte-for-byte indistinguishable from
-- "parsed, but the report insert failed and we lost the data". This table is the audit trail for a
-- security control, and an audit trail that reads wrong is a bad audit trail.
--
-- WHY A COLUMN AND NOT A NEW STATUS VALUE: the obvious fix was adding 'duplicate' to
-- CHECK (status IN (...)). D1/SQLite cannot ALTER a CHECK, so that needs a table rebuild -- and D1
-- ENFORCES foreign keys, so DROPping this table while aggregate_report.message_id references it fails
-- with SQLITE_CONSTRAINT_FOREIGNKEY. `PRAGMA defer_foreign_keys` does not rescue it either: D1 validates
-- at commit and resets the DB. (Both attempts rolled back cleanly; no data was harmed.) ADD COLUMN needs
-- no rebuild, so it touches no constraint and cannot strand the FK.
--
-- Reading the three outcomes after this:
--   status='parsed'   AND is_duplicate=0  -> parsed and stored          (linked report EXISTS)
--   status='parsed'   AND is_duplicate=1  -> redelivery, already had it (no linked report, CORRECT)
--   status='rejected'                     -> not stored, `error` says why
-- So `status='parsed' AND is_duplicate=0 AND no linked report` now means exactly one thing: a REAL
-- failure. That is the query worth alerting on.

ALTER TABLE inbound_message ADD COLUMN is_duplicate INTEGER NOT NULL DEFAULT 0;

-- Backfill the rows this flaw already mislabelled: a 'parsed' message linking to no report is, by
-- construction, one whose report had already been ingested.
UPDATE inbound_message
   SET is_duplicate = 1
 WHERE status = 'parsed'
   AND id NOT IN (SELECT message_id FROM aggregate_report);
