-- migrate:up

-- Widen the auth_audit_event event_type vocabulary to cover member management (Lane 2.6): a role change and
-- a removal. The column is a CHECK-constrained text (0013), so adding values = drop + re-add the constraint.
-- The append-only immutability triggers reject row UPDATE/DELETE, but this is DDL (ALTER, as the migration
-- owner), so it isn't blocked. No existing rows carry these values, so the swap can't fail on live data.
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

-- org_member_directory() — the ONLY way webhook_app may read member identity.
--
-- The members list needs each member's name + email, which live in `"user"` (Better Auth's GLOBAL identity
-- table). `"user"` is deliberately NOT row-level-secured — it is written by webhook_auth on the login path,
-- and it has no org column to police — so granting webhook_app a plain `select` on it would put tenant
-- isolation in the hands of every present and future query author remembering to join `memberships`. That is
-- app-layer filtering as the sole isolation mechanism, which is exactly what the data rule forbids.
--
-- Instead the join is sealed inside a SECURITY DEFINER function that hard-codes the org scope. webhook_app
-- gets EXECUTE on this and NO grant on `"user"`, so it cannot read the identity table any other way:
--   * SECURITY DEFINER runs as the migration owner, who may read `"user"`;
--   * `memberships` is FORCE RLS, so even the owner is policed by current_org_id() inside the function;
--   * plus an EXPLICIT `m.org_id = current_org_id()` predicate (never lean on RLS alone);
--   * current_org_id() is NULL when the tenant GUC is unset, so an un-scoped call returns ZERO rows
--     (deny-by-default) rather than the whole table;
--   * search_path is pinned, so a SECURITY DEFINER search-path hijack can't redirect the tables.
-- The result: there is no reachable query, now or later, by which the tenant role can see a user outside its
-- own org. Isolation is enforced in the database, not in application code.
create function org_member_directory()
  returns table (user_id text, name text, email text, role text, joined_at timestamptz)
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select m.user_id, u.name, u.email, m.role, m.created_at
      from memberships m
      join "user" u on u.id = m.user_id
     where m.org_id = current_org_id()
     order by m.created_at asc
  $$;

grant execute on function org_member_directory() to webhook_app;

-- migrate:down

drop function if exists org_member_directory();

-- Re-add the pre-0066 vocabulary as NOT VALID. A plain re-add would VALIDATE against existing rows, and the
-- moment this feature has been used there IS a member_removed / member_role_changed row — which can never be
-- deleted (auth_audit_event is append-only, its immutability triggers reject DELETE). A validating re-add
-- would therefore make this rollback permanently unrunnable. NOT VALID restores the constraint for all NEW
-- writes (the point of the rollback) while grandfathering the historical rows that the append-only contract
-- guarantees we can never remove.
alter table auth_audit_event drop constraint auth_audit_event_event_type_check;
alter table auth_audit_event add constraint auth_audit_event_event_type_check
  check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth',
    'invite_created', 'invite_accepted', 'invite_revoked')) not valid;
