-- migrate:up

-- "Which orgs do I belong to?" — the read that multi-org needs and that has been STRUCTURALLY IMPOSSIBLE
-- until now (Lane 2.4).
--
-- Every RLS policy on `memberships` is `org_id = current_org_id()` (0003), i.e. you can only ask about an
-- org you ALREADY know. That is precisely why `personalOrgId()` derives an id from the user id instead of
-- querying for one — and why `getConsentOrg` can only ever hand back the personal org. So an invited
-- teammate's CLI/MCP lands in their own empty personal org rather than the org they were invited to.
--
-- The fix is a SECOND, permissive SELECT policy keyed on the USER rather than the org, mirroring
-- current_org_id() with a current_app_user() GUC. Two notes on why this is safe NOW and would not have been
-- before:
--
--   1. Postgres policies are PERMISSIVE — they OR together. Adding a `user_id = current_app_user()` policy
--      makes any membership query WITHOUT an explicit org_id predicate silently CROSS-ORG. Three such
--      queries existed (billing/plan-switch) and were fixed in Lane S.4; every `memberships` read in the
--      codebase now names org_id explicitly. `scripts/memberships-org-scope-guard.mjs` (added with this
--      migration) fails the build if a new one ever appears — the policy makes that class of bug newly
--      dangerous, so it gets a lock, not a comment.
--   2. current_app_user() is NULL when the GUC is unset, so `user_id = NULL` matches NOTHING: every existing
--      caller (which sets only the tenant GUC) sees exactly the rows it saw before. Deny-by-default; this
--      migration is a no-op for all current code paths.
--
-- A SECURITY DEFINER function was the obvious alternative and does NOT work here: `memberships` is FORCE
-- RLS, so the definer is policed by current_org_id() too, and this read is inherently cross-org.

/** The current app user for RLS. NULL when app.current_user is unset/blank -> deny-by-default. */
create function current_app_user() returns text
  language sql stable
  as $$ select nullif(current_setting('app.current_user', true), '') $$;
comment on function current_app_user() is
  'Current authenticated user for user-scoped RLS policies. NULL when unset -> matches no rows.';

-- BOTH policies are scoped `to webhook_app` — the request-path role, the only one that ever asks "which
-- orgs am I in?". This is not cosmetic minimalism; it is load-bearing:
--
--   * A policy's expression is evaluated AS THE CALLING ROLE, not as the policy's owner. The orgs policy
--     below reads `memberships`, so an unscoped policy would require EVERY role that merely touches `orgs`
--     to hold a SELECT grant on `memberships` — webhook_billing, webhook_meter, webhook_sweeper,
--     webhook_reconciler, webhook_notifier. They don't, and they shouldn't: the first run of this migration
--     broke `update orgs set retention_days = …` as webhook_billing with "permission denied for table
--     memberships". Scoping to webhook_app keeps the other roles from ever evaluating it.
--   * It also keeps the OR-ing blast radius to one role: webhook_notifier has its own memberships policy,
--     and a broad self-select policy would silently widen what it can see.

-- Let a user see their OWN membership rows, in any org. OR'd with memberships_select (org_id =
-- current_org_id()), so it only ever ADDS the caller's own rows; it can never reveal another user's
-- membership, in any org.
create policy memberships_self_select on memberships
  for select to webhook_app
  using (user_id = current_app_user());

-- …and see the orgs those memberships point at (the switcher needs each org's NAME). Scoped through the
-- same predicate, so a user sees an org only if THEY are a member of it. The subquery reads memberships,
-- whose policies apply in turn — no recursion, since memberships' policies never reference orgs.
create policy orgs_member_select on orgs
  for select to webhook_app
  using (
    exists (
      select 1 from memberships m
       where m.org_id = orgs.id and m.user_id = current_app_user()
    )
  );

-- migrate:down

drop policy if exists orgs_member_select on orgs;
drop policy if exists memberships_self_select on memberships;
drop function if exists current_app_user();
