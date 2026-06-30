-- migrate:up

-- S3 slice 1b (ADR-0081): evolve delivery_attempts for SERVER-side remote delivery. Today the table is a
-- single localhost-replay record (status 'forwarded', status_code null — the CLI does the loopback POST,
-- the api records it). For a remote `{kind:"destination"}` replay the SERVER delivers: it CLAIMS a row
-- (status 'pending'), performs the guarded outbound POST, then FINALIZES it with the real HTTP outcome
-- (delivered / failed / blocked) + the true status_code. This migration adds the columns + constraints
-- those states need. It is ADDITIVE and INERT until the api orchestration + the claim/finalize helpers
-- land (next PR); the existing recordDeliveryAttempt path (status 'forwarded') is unaffected.

alter table delivery_attempts
  -- when the delivery was claimed — the lease anchor a future re-drive (Slice 4 DLQ) reads to detect a
  -- crashed-mid-delivery 'pending' row. Null for the legacy single-shot 'forwarded' records.
  add column claimed_at timestamptz,
  -- the replay_destinations row this delivery targeted (the remote kind). Null for localhost-tunnel rows.
  add column destination_id uuid;

-- A delivery references its allowlist destination in the SAME org (composite FK = defense-in-depth on RLS,
-- mirroring (event_id, org_id) → events). replay_destinations has unique (id, org_id), so the composite FK
-- is valid. NO explicit ON DELETE (→ NO ACTION): replay_destinations is SOFT-deleted (never hard-deleted by
-- the app), so the only delete is the org cascade — where the referencing delivery_attempts rows are ALSO
-- cascade-deleted via their own org_id FK, so NO ACTION's end-of-statement check sees no dangling reference.
-- (ON DELETE SET NULL is unusable on a composite FK here: it would null the NOT NULL org_id too and abort
-- the delete. A destination soft-delete keeps the row, so delivery history's destination link is preserved.)
alter table delivery_attempts
  add constraint delivery_attempts_destination_fk
  foreign key (destination_id, org_id) references replay_destinations (id, org_id);
-- Support the FK's referencing-side lookups (the org-cascade delete check + Slice 4's "deliveries for
-- destination X" reads) so they don't sequentially scan the growing delivery_attempts table.
create index delivery_attempts_destination_idx on delivery_attempts (destination_id);

-- Constrain status to the closed lifecycle vocabulary so a typo'd status becomes an error, not a silently
-- non-terminal stuck row. 'forwarded' = the legacy localhost record; pending/delivered/failed/blocked =
-- the server-delivery states. Every existing row is 'forwarded', so the CHECK validates cleanly. (Plain ADD
-- CONSTRAINT, not NOT VALID: delivery_attempts is a new, near-empty table, so the validation scan + the
-- brief ACCESS EXCLUSIVE lock are negligible; revisit a NOT VALID + separate-tx VALIDATE split at scale.)
alter table delivery_attempts
  add constraint delivery_attempts_status_check
  check (status in ('forwarded', 'pending', 'delivered', 'failed', 'blocked'));

-- migrate:down

alter table delivery_attempts drop constraint if exists delivery_attempts_status_check;
drop index if exists delivery_attempts_destination_idx;
alter table delivery_attempts drop constraint if exists delivery_attempts_destination_fk;
alter table delivery_attempts drop column if exists destination_id;
alter table delivery_attempts drop column if exists claimed_at;
