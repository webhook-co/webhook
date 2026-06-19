-- migrate:up

-- Harden the api_keys -> auth_grant link (Lane B A0c). 0014 added grant_id with a single-column FK
-- references auth_grant(id). The FK check is NOT RLS-filtered on the referenced row, so a key could
-- in principle be bound to ANOTHER org's grant (org_id=A, grant_id=<org B's grant>) — a cross-tenant
-- binding that today is prevented only by every caller RLS-checking the grant first. Replace it with a
-- COMPOSITE FK (grant_id, org_id) -> auth_grant(id, org_id) so the database enforces that a key's
-- grant is in the SAME org, making the cross-tenant binding structurally impossible (defense in depth
-- for the exported insertApiKey primitive). auth_grant already has unique(id, org_id) for this.
--
-- NULL grant_id (standalone keys via createApiKey) is unaffected: a FK with any NULL column is not
-- enforced (MATCH SIMPLE), so directly-created keys still need no grant. Lock note: dropping +
-- re-adding the constraint scans api_keys to validate the new FK — fine at the current near-empty
-- baseline; on a large table use ADD CONSTRAINT ... NOT VALID then VALIDATE CONSTRAINT.

alter table api_keys drop constraint api_keys_grant_id_fkey;
alter table api_keys
  add constraint api_keys_grant_org_fkey
  foreign key (grant_id, org_id) references auth_grant (id, org_id) on delete cascade;

-- migrate:down

alter table api_keys drop constraint api_keys_grant_org_fkey;
alter table api_keys
  add constraint api_keys_grant_id_fkey
  foreign key (grant_id) references auth_grant (id) on delete cascade;
