-- migrate:up

-- The notification-delivery database role (S3 Slice 3 PR3c-3). When a destination auto-disables, the engine
-- DO writes a `notification_intents` row (migration 0032) IN THE SAME tx as the disable — the engine can't
-- send mail (no identity-email read, no Resend binding), so the email is a separate, role-correct step. The
-- auth. worker (which already holds RESEND_API_KEY + the identity tables via webhook_auth) runs a cron that
-- drains pending intents → emails the org owner → marks the intent sent. That drain is an inherently
-- cross-org, control-plane read+update: it must see EVERY org's pending intents and resolve each org's
-- owner email. notification_intents + memberships are FORCE ROW LEVEL SECURITY, so the RLS-native way to
-- grant one role a cross-org view WITHOUT bypassing RLS is a role-TARGETED policy — the webhook_anchor (0010)
-- / webhook_reconciler (0033) pattern.
--
-- webhook_notifier is a NON-OWNER, NOSUPERUSER, NOBYPASSRLS role, created idempotently and mirroring
-- 0010/0020/0033: present for local/CI (trust auth), a no-op when ops pre-provisions it in a managed
-- environment (Neon) where the login password is injected out of band — never a password literal in source.
-- The role name is mirrored in packages/db/src/constants.ts (DB_ROLES.notifier); the catalog RLS tests assert
-- it has neither SUPERUSER nor BYPASSRLS and owns no tables.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_notifier') then
    create role webhook_notifier login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_notifier;

-- Role-targeted policies: FOR ... TO webhook_notifier only — never a bare policy webhook_app could ride.
-- SELECT the pending intents + the org's memberships (to find the owner); UPDATE only pending intents (to
-- flip them to sent). webhook_app's per-org policies are untouched.
create policy notification_intents_notifier_select on notification_intents
  for select to webhook_notifier using (true);
create policy notification_intents_notifier_update on notification_intents
  for update to webhook_notifier using (status = 'pending') with check (status = 'sent');
create policy memberships_notifier_select on memberships
  for select to webhook_notifier using (true);

-- COLUMN grants (least privilege). notification_intents: read the routing keys + status; write ONLY the
-- sent-marking columns. memberships: just enough to pick the owner. The GLOBAL, RLS-exempt `user` identity
-- table (webhook_auth's domain): only (id, email) for the owner's address — never name/image/verification.
-- The role never reads the destination URL, the delivery target, or any payload (the email links to the
-- dashboard by destination id), and holds no other write anywhere.
grant select (id, org_id, kind, destination_id, status, created_at) on notification_intents to webhook_notifier;
grant update (status, sent_at) on notification_intents to webhook_notifier;
grant select (org_id, user_id, role) on memberships to webhook_notifier;
grant select (id, email) on "user" to webhook_notifier;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_notifier') then
    revoke select (id, email) on "user" from webhook_notifier;
    revoke select (org_id, user_id, role) on memberships from webhook_notifier;
    revoke update (status, sent_at) on notification_intents from webhook_notifier;
    revoke select (id, org_id, kind, destination_id, status, created_at) on notification_intents from webhook_notifier;
    drop policy if exists memberships_notifier_select on memberships;
    drop policy if exists notification_intents_notifier_update on notification_intents;
    drop policy if exists notification_intents_notifier_select on notification_intents;
    revoke usage on schema public from webhook_notifier;
    drop role webhook_notifier;
  end if;
end
$$;
