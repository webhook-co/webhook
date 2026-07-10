-- migrate:up

-- A user's right to erasure (slice 2.2 account deletion): deleting their `user` row must self-clear
-- the two governance-audit references that otherwise BLOCK it. `auth_grant.approved_by` /
-- `revoked_by` (0013) are nullable "who approved / revoked this grant" columns whose FKs default to
-- NO ACTION — so a `delete from "user"` raises if that user ever approved or revoked any grant
-- (which may belong to a DIFFERENT org, and can't be swept from the identity role's context). The
-- erasure-correct behavior is to NULL the reference (not refuse the erasure, nor delete the grant),
-- so switch both to ON DELETE SET NULL. The grant's OWNER (`user_id`) still cascades (0013:16). No
-- RLS/grant change — auth_grant's policies + column grants are unchanged.
alter table auth_grant drop constraint if exists auth_grant_approved_by_fkey;
alter table auth_grant
  add constraint auth_grant_approved_by_fkey
  foreign key (approved_by) references "user" (id) on delete set null;

alter table auth_grant drop constraint if exists auth_grant_revoked_by_fkey;
alter table auth_grant
  add constraint auth_grant_revoked_by_fkey
  foreign key (revoked_by) references "user" (id) on delete set null;

-- migrate:down

alter table auth_grant drop constraint if exists auth_grant_approved_by_fkey;
alter table auth_grant
  add constraint auth_grant_approved_by_fkey
  foreign key (approved_by) references "user" (id);

alter table auth_grant drop constraint if exists auth_grant_revoked_by_fkey;
alter table auth_grant
  add constraint auth_grant_revoked_by_fkey
  foreign key (revoked_by) references "user" (id);
