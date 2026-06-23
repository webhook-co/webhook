-- migrate:up

-- The cross-org expiry cron-sweep role (ADR-0055). A daily auth.webhook.co cron prunes EXPIRED rows from
-- the two short-lived auth-handle tables (auth_refresh_token 0017, auth_session_exchange 0019) across EVERY
-- org — an inherently cross-org, control-plane housekeeping write. The on-access sweep (the per-org
-- sweepExpiredRefreshTokens/sweepExpiredSessionExchanges, run under webhook_app's org-scoped DELETE policy
-- after a consume) only ever touches the CONSUMING org, so a fully-churned/abandoned org never gets swept;
-- this role covers exactly that gap.
--
-- Both tables are FORCE ROW LEVEL SECURITY, so even the table owner is subject to RLS — a SECURITY DEFINER
-- function (which runs AS the owner) would see ZERO rows and prune nothing. The RLS-native way to grant one
-- role a cross-org DELETE WITHOUT bypassing RLS is a role-TARGETED permissive DELETE policy (the exact
-- pattern webhook_anchor uses for the cross-org audit-head read, migration 0010). BYPASSRLS and SUPERUSER
-- are both forbidden on the job path here (a catalog test asserts it), so neither is an option.
--
-- LEAST PRIVILEGE — this role is as small as the task allows:
--   * DELETE ONLY. No SELECT/INSERT/UPDATE grant on either table, so a leaked credential cannot READ any
--     handle row (the hashes, the org/grant/user linkage, the timestamps) — it can only delete.
--   * The role-targeted DELETE policy's USING clause is `expires_at < now()`, so even a bare
--     `delete from <table>` (no WHERE) can only ever remove ALREADY-EXPIRED rows — never a live handle. We
--     rely on the policy rather than a WHERE clause precisely so the role needs no SELECT privilege.
--   * The policy is scoped TO webhook_sweeper, so it never widens what webhook_app sees (permissive
--     policies OR together, but this one only applies to this role).
-- A leaked webhook_sweeper credential can therefore, at worst, delete already-expired (already-unusable)
-- handle rows across tenants — it cannot read, forge, mint, or alter a live session. See docs/threat-model.md.
--
-- webhook_sweeper is a NON-OWNER, NOSUPERUSER, NOBYPASSRLS role, created idempotently and mirroring
-- 0010/0016: present for local/CI (trust auth, no password) and a no-op when ops pre-provisions it in a
-- managed environment (Neon), where the login password is injected OUT OF BAND — never a password literal
-- in source (no-secrets). A LOGIN role with no password simply can't authenticate until ops sets one. The
-- role name is mirrored in packages/db/src/constants.ts (DB_ROLES.sweeper); the catalog RLS tests assert it
-- has neither SUPERUSER nor BYPASSRLS, owns no tables, and holds DELETE (and only DELETE) on the two tables.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_sweeper') then
    create role webhook_sweeper login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

-- Resolve objects in the schema; the DELETE grants below are the role's only object privileges.
grant usage on schema public to webhook_sweeper;

-- DELETE ONLY — never select/insert/update. With no read privilege the role can't see row data at all.
grant delete on auth_refresh_token, auth_session_exchange to webhook_sweeper;

-- Role-targeted permissive DELETE policies: FOR DELETE TO webhook_sweeper only, USING (expires_at < now()).
-- This is the cross-org gate — it lets webhook_sweeper delete expired rows in EVERY org while FORCE RLS
-- still denies webhook_app the same (webhook_app's own DELETE policy stays org-scoped). Because the role
-- holds no SELECT, the cron issues a bare DELETE and this USING clause is what bounds it to expired rows.
create policy auth_refresh_token_sweeper_delete on auth_refresh_token
  for delete to webhook_sweeper using (expires_at < now());
create policy auth_session_exchange_sweeper_delete on auth_session_exchange
  for delete to webhook_sweeper using (expires_at < now());

-- A btree index on expires_at so the cron's DELETE is index-driven rather than a full scan as the tables
-- grow. auth_session_exchange has no expires_at index yet (0019); auth_refresh_token only indexes grant_id
-- (0017), so add one here too. `if not exists` keeps this safe if a future migration adds either first.
create index if not exists auth_refresh_token_expires_at_idx on auth_refresh_token (expires_at);
create index if not exists auth_session_exchange_expires_at_idx on auth_session_exchange (expires_at);

-- migrate:down

-- Mirror 0010's down: revoke the grant, drop the policies + indexes this migration added, revoke usage, and
-- drop the role — all inside the idempotent `if exists` guard so a partial/repeat down is safe.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_sweeper') then
    drop index if exists auth_session_exchange_expires_at_idx;
    drop index if exists auth_refresh_token_expires_at_idx;
    drop policy if exists auth_session_exchange_sweeper_delete on auth_session_exchange;
    drop policy if exists auth_refresh_token_sweeper_delete on auth_refresh_token;
    revoke delete on auth_refresh_token, auth_session_exchange from webhook_sweeper;
    revoke usage on schema public from webhook_sweeper;
    drop role webhook_sweeper;
  end if;
end
$$;
