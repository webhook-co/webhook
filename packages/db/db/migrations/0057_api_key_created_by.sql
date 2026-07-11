-- migrate:up

-- api_keys.created_by — WHICH HUMAN minted this credential.
--
-- Today a standalone (dashboard-minted) key has no link to a person at all: `grant_id` is null for it, and
-- there is no owner column. So "who created this key?" is unanswerable from the key row — you would have to
-- walk the audit chain — and, worse, when a member is removed from an org there is no query that can even
-- FIND their keys in order to revoke them. Offboarding cannot revoke what it cannot enumerate.
--
-- This is also the column the mint ceiling needs: a key may not grant more than the human who created it,
-- and enforcing that later is worthless if we cannot say who that human was.
--
-- It CANNOT be backfilled — the information does not exist anywhere for keys minted before this — so every
-- day it is absent is a permanent attribution gap for the keys minted that day.
--
-- `on delete set null`, NEVER `cascade`:
--   * cascade would DELETE the api_keys row when the user is erased. That destroys the revocation record and
--     orphans a credential that is still live at the edge — erasing a person must not erase the evidence of,
--     or the ability to revoke, what they created. Migration 0051 decoupled the audit tables' FK for exactly
--     this reason: history has to survive the subject.
--   * set null keeps the key, its scopes, and its revocation state; only the attribution is forgotten, which
--     is precisely what erasure is supposed to do.
--
-- Nullable, no default, no rewrite: a plain metadata-only ALTER. Existing rows keep `created_by = null`,
-- which reads honestly as "we don't know" rather than pretending to an attribution we never captured.
alter table api_keys
  add column created_by text references "user" (id) on delete set null;

-- Offboarding asks exactly one question of this table: "which keys did this person mint in this org?" —
-- so index it the way that question is shaped. Partial: a null created_by is the legacy/unattributed case
-- and is never the subject of that query, so it stays out of the index.
create index api_keys_created_by_idx
  on api_keys (org_id, created_by)
  where created_by is not null;

-- webhook_authn (the bearer-resolution role, the most exposed in the system) is granted a DELIBERATELY
-- narrow column list on api_keys and must not learn who created a key — it only ever answers "is this
-- credential valid, and for which org". Nothing is granted here; the existing grant is unchanged.

-- migrate:down

drop index if exists api_keys_created_by_idx;
alter table api_keys drop column if exists created_by;
