-- migrate:up

-- Widen the auth_audit_event event_type vocabulary to cover member management (Lane 2.6): a role change and
-- a removal. Same shape as 0065 (invites): the column is a CHECK-constrained text (0013), so adding values =
-- drop + re-add the constraint. The append-only immutability triggers reject row UPDATE/DELETE, but this is
-- DDL (ALTER, as the migration owner), so it isn't blocked. No existing rows carry these values, so the swap
-- can't fail on live data.
--
-- Both events are consequential: a role change can REVOKE the member's credentials (a key minted under an
-- authority they no longer hold must die), and a removal revokes their grants + keys and deletes the
-- membership. The audit row is written in the SAME transaction as the mutation, so the trail can never
-- disagree with the state.
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked',
    'member_role_changed', 'member_removed'));

-- The members list needs each member's identity (name + email) to be useful. `"user"` is Better Auth's
-- GLOBAL identity table: it is deliberately NOT row-level-secured (it is written by webhook_auth on the
-- login path, and enabling RLS on it would put that path at risk), so it carries no org column to police.
-- The house pattern for reading it from a tenant role is therefore a COLUMN-SCOPED grant — exactly what
-- migration 0034 already does for webhook_notifier (`select (id, email)`). Mirror it for webhook_app, with
-- `name` added because the members UI shows it.
--
-- ⚠️ Because `"user"` is not RLS-scoped, the JOIN is what scopes the read: every query that touches it MUST
-- go through `memberships` under the org's RLS context WITH an explicit org_id predicate (see
-- listOrgMembers). A bare `select from "user"` would see every user — the grant is narrow (3 columns, no
-- write) precisely to bound that blast radius.
grant select (id, name, email) on "user" to webhook_app;

-- migrate:down

revoke select (id, name, email) on "user" from webhook_app;

alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked'));
