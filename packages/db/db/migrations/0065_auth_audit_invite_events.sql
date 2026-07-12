-- migrate:up

-- Widen the auth_audit_event event_type vocabulary to cover org invitations (Lane 2.5): create / accept /
-- revoke. The column is a CHECK-constrained text (0013); adding values = drop + re-add the constraint. The
-- append-only immutability triggers reject row UPDATE/DELETE, but this is DDL (ALTER, as the migration
-- owner), so it isn't blocked. No existing rows carry these values, so the swap can't fail on live data.
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked'));

-- migrate:down

alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth'));
