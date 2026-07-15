-- migrate:up

-- The free-org-cap reconciler role (PR2b slice 2).
--
-- The creation-time gate (org-create-actions) is BEST-EFFORT: it can't catch a check-then-create race, and it
-- can't see the paid→Free downgrade that later pushes a user over the cap. The authoritative enforcement is a
-- periodic cron that, across ALL users, finds owners of more FREE orgs than the cap and suspends the overflow.
--
-- "Which users own too many free orgs?" is inherently CROSS-USER and CROSS-ORG. Every existing free-org helper
-- is per-user (listUserOrgs under the user GUC); no tenant-scoped role can hop users. The RLS-native way to
-- grant exactly one caller that reach WITHOUT a permissive policy webhook_app could ride is a role-TARGETED
-- `FOR SELECT TO webhook_capreconciler USING (true)` policy — the exact pattern webhook_reconciler uses for
-- delivery_attempts (0033) and webhook_meter for events (0043). Permissive policies OR together, but these are
-- scoped to webhook_capreconciler, so webhook_app still sees only its own org through the existing per-org
-- policies. The COLUMN grants below bound WHICH columns the role can ever read — it needs only the ownership
-- graph (memberships), the entitlement (billing_subscriptions.status), and each org's identity + service
-- state. It gets NO write here (a later slice adds the suspend write), and never sees payloads, secrets, or
-- billing identifiers.
--
-- webhook_capreconciler is NON-OWNER, NOSUPERUSER, NOBYPASSRLS, created idempotently and password-less
-- (mirroring 0033/0034): present for local/CI trust auth, a no-op when ops pre-provisions it on Neon with an
-- out-of-band password. The catalog RLS tests assert it holds neither SUPERUSER nor BYPASSRLS and owns no
-- tables.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_capreconciler') then
    create role webhook_capreconciler login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_capreconciler;

-- Role-targeted cross-org SELECT policies — FOR SELECT TO webhook_capreconciler only, never a bare USING(true)
-- any other role could ride. These are the cross-user read gate; the column grants bound the exposure.
create policy memberships_capreconciler_select on memberships
  for select to webhook_capreconciler using (true);
create policy orgs_capreconciler_select on orgs
  for select to webhook_capreconciler using (true);
create policy billing_subscriptions_capreconciler_select on billing_subscriptions
  for select to webhook_capreconciler using (true);

-- COLUMN-level grants: only the fields the over-cap detection needs. memberships gives the ownership graph;
-- billing_subscriptions.status gives the paid-vs-Free entitlement; orgs gives identity, birth order (to keep
-- the oldest), and current service state (to skip an already-suspended org). No payload/secret/target columns,
-- and no INSERT/UPDATE/DELETE — this slice only DETECTS.
grant select (org_id, user_id, role) on memberships to webhook_capreconciler;
grant select (org_id, status) on billing_subscriptions to webhook_capreconciler;
grant select (id, created_at, status, suspended_reason) on orgs to webhook_capreconciler;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_capreconciler') then
    revoke select (org_id, user_id, role) on memberships from webhook_capreconciler;
    revoke select (org_id, status) on billing_subscriptions from webhook_capreconciler;
    revoke select (id, created_at, status, suspended_reason) on orgs from webhook_capreconciler;
    drop policy if exists memberships_capreconciler_select on memberships;
    drop policy if exists orgs_capreconciler_select on orgs;
    drop policy if exists billing_subscriptions_capreconciler_select on billing_subscriptions;
    revoke usage on schema public from webhook_capreconciler;
    drop role webhook_capreconciler;
  end if;
end
$$;
