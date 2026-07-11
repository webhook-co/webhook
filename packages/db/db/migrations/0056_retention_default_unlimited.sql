-- migrate:up

-- Retention default must fail SAFE (S2a). 0054 added `orgs.retention_days` with `DEFAULT 7` (the Free
-- window). But the parser that mirrors this column from a plan's price metadata fails in the OPPOSITE
-- direction on purpose (billing-sync.ts parseRetentionFromPriceMetadata): an absent/unparseable/"unlimited"
-- window resolves to NULL = unlimited, because "the dangerous mistake is deleting a paying customer's data
-- too soon … over-retention is the safe miss; premature deletion is not recoverable."
--
-- The COLUMN DEFAULT disagreed with that: any insert path that forgets retention_days got 7, so a paid org
-- whose subscription hasn't mirrored yet (or failed to parse) would be pruned at the Free window on day 8.
-- Flip the default to NULL so a missing window OVER-retains rather than destroys — the two now agree.
--
-- This does NOT make Free orgs unlimited: bootstrapPersonalOrg writes retention_days = 7 explicitly (the one
-- real free-org creation path), and billing-sync writes the Free window on downgrade/cancel. The default is
-- only the last-resort backstop for every OTHER insert path — and that backstop must never delete data.
alter table orgs alter column retention_days set default null;

-- No backfill. Existing rows already hold their correct window (7 for Free, mirrored for paid, NULL for
-- Enterprise). A DEFAULT change only affects rows inserted from here on; touching existing rows would risk
-- overwriting a mirrored paid window with NULL.

-- migrate:down

alter table orgs alter column retention_days set default 7;
