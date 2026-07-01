-- migrate:up

-- The delivery-reconciliation database role (S3 Slice 3 PR3c-2). The native auto-delivery loop wakes a
-- destination's per-destination DO inline at ingest, but a wake can be LOST (the DO fan-out failed after the
-- delivery row was already durable) or become STALE (a destination re-enabled via `replay enable` accrues
-- queued rows but nothing re-wakes its idle DO). The engine's hourly cron needs to FIND, across ALL orgs,
-- destinations that have a due-but-unclaimed delivery on a live+enabled destination, and re-wake their DOs —
-- an inherently cross-org, control-plane READ. delivery_attempts + replay_destinations are FORCE ROW LEVEL
-- SECURITY, so even the owner is subject to RLS; only SUPERUSER or BYPASSRLS could bypass, and this codebase
-- forbids both off the owner/migration path (the catalog leak tests assert it). The RLS-native way to grant
-- one role a cross-org read WITHOUT bypassing RLS is a role-TARGETED permissive policy — the exact pattern
-- webhook_anchor uses for audit_log (0010) and webhook_authn for api_keys (0009).
--
-- webhook_reconciler is a NON-OWNER, NOSUPERUSER, NOBYPASSRLS role, created idempotently and mirroring
-- 0010/0020: present for local/CI (trust auth), a no-op when ops pre-provisions it in a managed environment
-- (Neon) where the login password is injected out of band — never a password literal in source (no-secrets).
-- The role name is mirrored in packages/db/src/constants.ts (DB_ROLES.reconciler); the catalog RLS tests
-- assert it has neither SUPERUSER nor BYPASSRLS and owns no tables.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_reconciler') then
    create role webhook_reconciler login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_reconciler;

-- Role-targeted SELECT policies: FOR SELECT TO webhook_reconciler only — never a bare USING(true) that
-- webhook_app could also ride. Permissive policies OR together, but these are scoped to webhook_reconciler,
-- so webhook_app still sees only its own org via the existing per-org policies. These are the cross-org read
-- gate; the COLUMN grants below bound WHICH columns the role can ever read.
create policy delivery_attempts_reconciler_select on delivery_attempts
  for select to webhook_reconciler using (true);
create policy replay_destinations_reconciler_select on replay_destinations
  for select to webhook_reconciler using (true);

-- COLUMN-level grants (NOT table-level): the reconciler reads ONLY the fields it needs to decide which DO to
-- wake — the org + destination keys, the delivery status, and the retry due-time on delivery_attempts; and
-- the identity + liveness flags on replay_destinations. It must NEVER see the payload pointer, the captured
-- headers, the target URL, or the destination's signing config. With no INSERT/UPDATE/DELETE grant it cannot
-- write: every delivery mutation still happens inside the DO under webhook_app RLS. A leaked
-- webhook_reconciler credential can enumerate which destinations have stranded work across tenants but cannot
-- read event/destination content, deliver, or alter any row.
grant select (org_id, destination_id, status, next_retry_at) on delivery_attempts to webhook_reconciler;
grant select (id, org_id, deleted_at, disabled_at) on replay_destinations to webhook_reconciler;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_reconciler') then
    revoke select (org_id, destination_id, status, next_retry_at) on delivery_attempts from webhook_reconciler;
    revoke select (id, org_id, deleted_at, disabled_at) on replay_destinations from webhook_reconciler;
    drop policy if exists delivery_attempts_reconciler_select on delivery_attempts;
    drop policy if exists replay_destinations_reconciler_select on replay_destinations;
    revoke usage on schema public from webhook_reconciler;
    drop role webhook_reconciler;
  end if;
end
$$;
