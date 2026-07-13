-- migrate:up

-- Widen the auth_audit_event event_type vocabulary for org lifecycle: creating a team, and renaming an org
-- (which — because the slug is the URL — is a security-relevant, owner/admin-only action worth a tamper-
-- evident trail). Same drop-and-re-add shape as 0065/0066.
--
-- `not valid`: this is a SUPERSET of the old vocabulary, so every existing row already satisfies it — a
-- validating ADD CONSTRAINT would take ACCESS EXCLUSIVE and full-scan the (append-only, ever-growing) audit
-- table just to confirm what is true by construction. Skipping that validation is safe here precisely because
-- widening cannot make an existing row invalid; new rows are still checked. (The `down` uses `not valid` too,
-- but there for a different, load-bearing reason: it NARROWS, so validating would fail on any org_* row.)
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked',
    'member_role_changed', 'member_removed',
    'org_created', 'org_renamed'))
  not valid;

-- migrate:down

-- Narrowing an append-only table's CHECK validates against existing rows, so the moment either event type has
-- been written this `down` would fail — re-add it `not valid` (the 0066 pattern), which reinstates the old
-- vocabulary for NEW rows without re-checking the history.
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked',
    'member_role_changed', 'member_removed'))
  not valid;
