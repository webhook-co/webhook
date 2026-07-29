-- Give the scheduled health check somewhere to remember what it has already said.
--
-- WHY: without this the daily cron is stateless, and a stateless alerter has exactly two settings, both
-- useless. Either it re-sends every standing problem every single day -- and a channel that repeats
-- itself gets filtered, which is worse than no channel -- or it only ever looks at "today", and then any
-- failure arriving in a report that lands while the cron is between runs is never mentioned at all.
--
-- WHY A KEY/VALUE TABLE AND NOT COLUMNS: the two things worth remembering have nothing in common --
-- a monotonic report cursor and a wall-clock timestamp -- and there will never be one row "about" an
-- entity here. A 2-column table cannot drift out of shape as the checks grow, and adding a third key
-- needs no migration at all.
--
-- KEYS IN USE:
--   last_alerted_report_pk  -- MAX(aggregate_report.id) already covered by an alert. The cursor advances
--                              ONLY after a send succeeds, so a failed send retries rather than skipping.
--                              A cursor beats a time window because report windows arrive out of order:
--                              a reporter can deliver a 3-day-old window today, and "records since
--                              yesterday" would miss it while "report ids above N" cannot.
--   last_stale_alert_at     -- unix seconds. Staleness persists by nature (a dead feed is stale forever),
--                              so it repeats on a slow clock instead of the daily evaluation clock.

CREATE TABLE alert_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed the cursor at the current high-water mark.
--
-- THIS IS DELIBERATE AND IT MATTERS: without it the first cron run would evaluate every record ever
-- ingested and alert on history that has already been read, reviewed and understood by a human. A
-- monitor whose very first message is a false alarm about the past has taught its reader to ignore it
-- before it has ever reported anything real. COALESCE handles the empty-database case.
INSERT INTO alert_state (key, value)
VALUES ('last_alerted_report_pk', (SELECT COALESCE(MAX(id), 0) FROM aggregate_report));
