-- migrate:up

-- Onboarding profile fields on the Better-Auth-owned "user" table.
--
-- These are declared as Better Auth `additionalFields` in apps/auth/src/auth.ts, so the schema GENERATOR emits
-- them and the CI drift guard stays green. This migration is the hand-owned dbmate counterpart that actually
-- applies them (better-auth never migrates prod itself — the emitted DDL is checked in and owned here).
--
--   * first_name / last_name (camelCase "firstName"/"lastName" to match the table's existing "emailVerified"):
--     Google's OAuth profile returns given_name/family_name, and until now they were discarded — only the
--     composite "name" survived. The runtime maps them in; onboarding lets a magic-link user (who has no
--     provider profile) enter them by hand.
--   * onboarded_at ("onboardedAt"): NULL until the user finishes the onboarding screen. It is the durable
--     signal that gates the screen. Inferring "have they onboarded?" from whether their org still bears an
--     auto-generated name is a heuristic that breaks the moment someone names their org "Personal" — and
--     re-showing onboarding to a user who already did it is a worse bug than not having the column.
--
-- Nullable, no default, no backfill: every EXISTING user is treated as already-onboarded (onboardedAt stays
-- NULL but the gate also checks that they predate this feature — see the resolver). Adding a nullable column
-- to a large table is metadata-only in Postgres, so this is safe on a live table.

alter table "user" add column "firstName" text;
alter table "user" add column "lastName" text;
alter table "user" add column "onboardedAt" timestamptz;

-- migrate:down

alter table "user" drop column "onboardedAt";
alter table "user" drop column "lastName";
alter table "user" drop column "firstName";
