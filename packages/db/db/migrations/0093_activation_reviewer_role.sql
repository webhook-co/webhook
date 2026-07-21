-- migrate:up

-- webhook_activation_reviewer — the least-privilege reader behind the internal, founder-only
-- `GET /v1/internal/activation/weekly` endpoint (ADR-0127, #708). The endpoint opens its own connection over
-- the reviewer Hyperdrive and calls activation_weekly_review() (0092): SECURITY DEFINER, AGGREGATE-ONLY —
-- per-week counts + TTFV percentiles, never an org_id, never PII.
--
-- WHY THIS MIGRATION EXISTS (#721): the role was provisioned BY HAND in production and lived in no
-- migration, so a database rebuilt from migrations silently lacked the read path, `pnpm dev:db` failed the
-- required-login-role check, and the production caller's grant was pinned by no test. Every other
-- least-privilege role (0016 auth, 0020 sweeper, 0033 reconciler, 0034 notifier, 0040 meter, 0046
-- meter_audit, 0047 billing, 0050 meter_transport, 0051 purge, 0053 retention, 0084 capreconciler, 0091
-- reaper) is created by its migration; this one now is too.
--
-- WHAT IT IS GRANTED HERE is USAGE on schema public + EXECUTE on that ONE function. Deliberately NO table
-- grants — not even SELECT on the three activation tables — because the SECURITY DEFINER function does the
-- reading. So it holds ZERO table privileges and cannot read activation_org_milestones / _weekly /
-- _exclusions, orgs or events directly. (Asserted in packages/db/test/activation-rollup.test.ts.)
--
-- ⚠️ Note that holding no TABLE grants is not by itself containment. USAGE on schema public also carries
-- PUBLIC's default EXECUTE on every function that has not revoked it — so before 0094 this role, like the
-- eleven other least-privilege roles that hold the same USAGE, could reach the identity SECURITY DEFINER
-- helpers whose only gate is a caller-settable GUC. 0094 (the very next migration) revokes PUBLIC from those
-- three, which is what makes the narrow grant list above an actual boundary rather than a description.
--
-- This is the FIRST `grant execute` in the schema aimed at a least-privilege role rather than webhook_app,
-- and it narrows activation_weekly_review()'s ACL from owner-only to {owner, reviewer} — which the
-- remote-db-test-guard's R5 derives straight from this file, so the reviewer handle becomes an entitled
-- caller at lint time without any hand-maintained list.
--
-- Created PASSWORD-LESS, exactly like the other cron/reader roles: the password is injected out of band, and
-- production ALREADY holds a hand-provisioned password + Hyperdrive binding for this role. The create is
-- therefore guarded by `if not exists`, so applying this to prod is a no-op that must NOT reset that
-- password or disturb the binding.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_activation_reviewer') then
    create role webhook_activation_reviewer login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_activation_reviewer;
grant execute on function activation_weekly_review() to webhook_activation_reviewer;

-- migrate:down

-- Fully guarded, mirroring 0091: the revokes live INSIDE the `if exists` so a rollback on a database where
-- the role was never created cannot raise (a `revoke … from <nonexistent role>` errors, which would make the
-- guard unreachable — the shape 0047/0051/0053 got wrong). The revokes are required before the drop, since
-- Postgres refuses to drop a role that still holds privileges. activation_weekly_review() is guaranteed to
-- still exist here: migrations roll back in reverse order, so 0092's `drop function` runs after this.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_activation_reviewer') then
    revoke execute on function activation_weekly_review() from webhook_activation_reviewer;
    revoke usage on schema public from webhook_activation_reviewer;
    drop role webhook_activation_reviewer;
  end if;
end
$$;
