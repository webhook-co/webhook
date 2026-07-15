-- migrate:up

-- Widen org_member_directory() to also return each member's `image` (the OAuth provider avatar URL). The Team
-- page renders a member's face next to their name; `image` lives on the un-RLS'd global `user` table
-- (webhook_app can't read it directly), so it comes through this SECURITY DEFINER function alongside
-- name/email — the same trusted, org-scoped path (the WHERE pins to current_org_id(), so a caller only ever
-- sees their own org's members). An UPLOADED avatar is found by the deterministic R2 key from the member's id
-- (no pointer column needed here), so only `image` is added — keeping the definer's exposed surface minimal.
--
-- A function's `returns table (...)` columns are part of its signature, so this is a DROP + CREATE (not
-- CREATE OR REPLACE, which can't change the return type). Re-grant EXECUTE after recreate.

drop function if exists org_member_directory();

create function org_member_directory()
  returns table (
    user_id text,
    name text,
    email text,
    role text,
    joined_at timestamptz,
    image text
  )
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select m.user_id, u.name, u.email, m.role, m.created_at, u.image
      from memberships m
      join "user" u on u.id = m.user_id
     where m.org_id = current_org_id()
     order by m.created_at asc
  $$;

grant execute on function org_member_directory() to webhook_app;

-- migrate:down

drop function if exists org_member_directory();

-- Restore the pre-0082 5-column shape.
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
