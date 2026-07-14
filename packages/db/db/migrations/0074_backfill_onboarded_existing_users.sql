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

update "user" set "onboardedAt" = "createdAt" where "onboardedAt" is null;

-- migrate:down

-- Irreversible by nature: once stamped we cannot tell a grandfathered user from one who truly onboarded at
-- their signup time. The down is a no-op rather than a lossy guess — rolling 0073 back drops the column
-- entirely, which is the real "undo".
select 1;
