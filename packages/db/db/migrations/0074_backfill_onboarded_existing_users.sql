-- migrate:up

-- Grandfather every EXISTING user as already-onboarded.
--
-- 0073 added `onboardedAt` with no default and no backfill, so right now every user who signed up before
-- onboarding existed reads as `onboardedAt IS NULL` — which is the exact signal the gate uses for "show the
-- onboarding screen". Without this, the first thing every current user sees on their next login is an
-- onboarding flow they neither need nor asked for.
--
-- Stamp their onboarding time as their signup time: they onboarded implicitly by already using the product.
-- After this runs, `onboardedAt IS NULL` means precisely "a NEW signup that has not finished onboarding" —
-- which is what the gate wants it to mean.
--
-- Idempotent and one-shot: it only touches rows that are still NULL, so re-running changes nothing, and any
-- signup that lands after this migration keeps its NULL and goes through onboarding normally.
--
-- Deliberately a SINGLE atomic statement (not a batched loop). At this point the `user` table is small (the
-- product is early in prod), so the UPDATE completes in milliseconds and a single transaction is the SAFEST
-- shape: it either fully applies or fully rolls back, with no partial-backfill state to reason about. Batching
-- would require `-- migrate:no-transaction` + a bounded loop and would trade that atomicity for lock-duration
-- headroom this table does not need yet. If the user table ever grows large enough that a full-table row
-- rewrite would hold locks long enough to stall concurrent sign-ups, convert this to a keyset-batched backfill
-- BEFORE running it there — but it has already run against a small table, so that window is closed here.

update "user" set "onboardedAt" = "createdAt" where "onboardedAt" is null;

-- migrate:down

-- Irreversible by nature: once stamped we cannot tell a grandfathered user from one who truly onboarded at
-- their signup time. The down is a no-op rather than a lossy guess — rolling 0073 back drops the column
-- entirely, which is the real "undo".
select 1;
