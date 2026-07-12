-- migrate:up

-- "Which orgs do I belong to?" — the read multi-org needs, and which has been STRUCTURALLY IMPOSSIBLE
-- until now (Lane 2.4).
--
-- Every RLS policy on `memberships` is `org_id = current_org_id()` (0003): you can only ask about an org you
-- ALREADY name. That is exactly why `personalOrgId()` derives an id instead of querying for one — and why
-- `getConsentOrg` can only ever hand back the personal org, so an invited teammate's CLI/MCP lands in their
-- own empty org instead of the org they were invited to.
--
-- HOW NOT TO DO IT (the design this replaces). The obvious move is a permissive `memberships_self_select`
-- policy on webhook_app: `using (user_id = current_app_user())`. It works — and it quietly arms a privilege
-- escalation, because Postgres policies OR together. From that moment ANY membership read that does not name
-- org_id is silently CROSS-ORG. That is not hypothetical: Lane S.4 fixed three queries shaped exactly like
-- `select role from memberships where user_id = $1 limit 1` — no org_id, no ORDER BY. Under such a policy
-- that returns an ARBITRARY row, so a plain `member` of a team who OWNS their personal org reads back
-- `owner` and passes an owner/admin gate ON THE TEAM.
--
-- Guarding that with a lint rule was tried and rejected: a static text scanner over SQL is bypassable (a CTE
-- mentioning org_id, string-built SQL, a stray backtick) and a leaky lock on a live escalation is worse than
-- no lock, because it manufactures confidence. So the hazard is removed instead of guarded:
--
--   webhook_app gets NO new policy. Its view of `memberships` is UNCHANGED — still `org_id =
--   current_org_id()`, so an unqualified read by the request-path role still cannot see another org. There
--   is nothing to escalate through.
--
-- The cross-org capability is instead CONFINED to one SECURITY DEFINER function. Inside it, current_user is
-- the definer (webhook_owner), and the two policies below — scoped `to webhook_owner`, so no other role can
-- ever evaluate them — let exactly that function, and nothing else, resolve the caller's own memberships.
-- FORCE ROW LEVEL SECURITY is what makes this sound: the definer is policed too, so the function is bounded
-- by these policies rather than bypassing RLS.

/** The current app user for the org-directory policies. NULL when unset -> matches no rows. */
create function current_app_user() returns text
  language sql stable
  as $$ select nullif(current_setting('app.current_user', true), '') $$;
comment on function current_app_user() is
  'Current authenticated user for the org-directory policies. NULL when unset -> matches no rows.';

-- Scoped `to webhook_owner`: ONLY reachable from inside a SECURITY DEFINER function owned by it. The
-- request-path role (webhook_app) is deliberately NOT listed, so its policy set — and therefore its
-- exposure to the OR-ing hazard above — is exactly what it was before this migration.
create policy memberships_directory_select on memberships
  for select to webhook_owner
  using (user_id = current_app_user());

-- The directory needs each org's NAME. Same confinement. The subquery reads `memberships`, whose policies
-- apply in turn (as webhook_owner, the policy above) — no recursion, since memberships' policies never
-- reference orgs.
create policy orgs_directory_select on orgs
  for select to webhook_owner
  using (
    exists (
      select 1 from memberships m
       where m.org_id = orgs.id and m.user_id = current_app_user()
    )
  );

-- The ONE way webhook_app may ask the cross-org question. It cannot be pointed at another user: it takes no
-- argument and reads current_app_user(), which is NULL unless the caller set the GUC (withUser, from the
-- verified session) -> deny-by-default. search_path is pinned so the definer cannot be search-path-hijacked.
create function user_org_directory()
  returns table (org_id uuid, name text, role text)
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select m.org_id, o.name, m.role
      from memberships m
      join orgs o on o.id = m.org_id
     where m.user_id = current_app_user()
     order by m.created_at asc, m.org_id asc
  $$;

grant execute on function user_org_directory() to webhook_app;

-- memberships' PK leads with org_id, so a user_id-leading lookup would seq-scan. The directory filters on
-- user_id alone.
create index memberships_user_id_idx on memberships (user_id);

-- migrate:down

drop index if exists memberships_user_id_idx;
drop function if exists user_org_directory();
drop policy if exists orgs_directory_select on orgs;
drop policy if exists memberships_directory_select on memberships;
drop function if exists current_app_user();
