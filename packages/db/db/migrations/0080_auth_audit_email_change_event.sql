-- migrate:up

-- Widen the auth_audit_event vocabulary for `email_changed`: a user changing their account email is a
-- security-relevant identity event (it moves where password-reset / magic-link / security notices go), worth a
-- tamper-evident trail. Same drop-and-re-add shape as 0065/0066/0071. The row is written to the user's
-- PERSONAL-ORG chain (the ceremony's commit path), since auth_audit_event is per-org + RLS.
--
-- `not valid`: this is a SUPERSET of the old vocabulary, so every existing row already satisfies it — a
-- validating ADD CONSTRAINT would take ACCESS EXCLUSIVE and full-scan the append-only audit table to confirm
-- what is true by construction. Safe to skip precisely because widening cannot invalidate an existing row.
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked',
    'member_role_changed', 'member_removed',
    'org_created', 'org_renamed', 'email_changed'))
  not valid;

-- migrate:down

-- Narrowing validates against existing rows, so the moment an email_changed row exists this `down` would fail
-- — re-add `not valid` (the 0066/0071 pattern), reinstating the prior vocabulary for NEW rows only.
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked',
    'member_role_changed', 'member_removed',
    'org_created', 'org_renamed'))
  not valid;
