-- migrate:up

-- Take PUBLIC's default EXECUTE off the three identity/directory SECURITY DEFINER functions.
--
-- THE GAP. Postgres grants EXECUTE to PUBLIC on every new function, and until now
-- activation_weekly_review() (0092) was the schema's ONLY `revoke … from public`. Every other function was
-- therefore callable by any role that can log in and holds USAGE on schema public — which is all twelve
-- least-privilege roles (webhook_ingest, webhook_sweeper, webhook_reaper, webhook_retention, the meter and
-- billing roles, the new webhook_activation_reviewer, …). The explicit `grant execute … to webhook_app` on
-- these functions was therefore decorative: it granted what everyone already had.
--
-- That matters because these three are SECURITY DEFINER and gated ONLY by a session GUC the caller sets
-- itself. current_user_profile() (0068) returns `name, email` for `current_app_user()`; user_org_directory()
-- (0067) and org_member_directory() (0066) answer the cross-org membership questions off `app.current_user` /
-- `app.current_org`. A caller with any of those roles' credentials could `set_config('app.current_user', …)`
-- for an arbitrary victim and read their identity — no table grant needed, since the definer supplies the
-- privilege. Verified by direct probe on a migrated database before writing this, not inferred.
--
-- The fix is the same shape 0092 already uses for the activation review: REVOKE from PUBLIC, and rely on the
-- explicit role grant. webhook_app keeps its grant (re-issued below so this migration is self-contained and
-- order-independent), so the request path is untouched — it is the only role that ever called these, in
-- packages/db/src/{orgs,members}.ts. Nothing else needs them.
--
-- ⚠️ DURABILITY TRAP: `create or replace function` PRESERVES an ACL, but a `drop` + `create` RESETS it, which
-- would silently hand PUBLIC its EXECUTE back. Several later migrations do recreate these (0069, 0070, 0082,
-- 0083, 0091). So the invariant is pinned by an assertion over the FINAL migrated schema in
-- packages/db/test/rls.test.ts — `aclexplode(proacl)` must contain no PUBLIC (grantee 0) entry for any of
-- them — rather than trusting that this file is the last word.

revoke execute on function current_user_profile() from public;
revoke execute on function user_org_directory() from public;
revoke execute on function org_member_directory() from public;

grant execute on function current_user_profile() to webhook_app;
grant execute on function user_org_directory() to webhook_app;
grant execute on function org_member_directory() to webhook_app;

-- migrate:down

-- Restore Postgres' default so the rollback really is a rollback. The webhook_app grants are left in place:
-- they predate this migration (0066/0067/0068) and are not ours to remove.
grant execute on function current_user_profile() to public;
grant execute on function user_org_directory() to public;
grant execute on function org_member_directory() to public;
