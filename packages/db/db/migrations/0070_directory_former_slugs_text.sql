-- migrate:up

-- `user_org_directory().former_slugs` returns TEXT, not text[].
--
-- 🐞 0069 declared it `text[]`, which is the obviously-right type and does not work here. `createClient` sets
-- `fetch_types: false` (deliberately — see packages/db/src/client.ts), so postgres.js never loads the type
-- catalogue and cannot parse an array OID. It hands the column back as the RAW POSTGRES LITERAL, a string:
--
--     "{beta-old,beta-ancient}"      -- a string, not an array
--
-- So `formerSlugs.some(...)` threw `TypeError: o.formerSlugs.some is not a function` on the first real
-- request — and every unit test passed, because they mock `listUserOrgs`, and the real-Postgres test passed
-- too, because it asserted `expect(formerSlugs).toContain("beta-old")` and **`toContain` matches a SUBSTRING
-- when the subject is a string**. A vacuously green assertion over a value of entirely the wrong type. Only
-- the browser found it.
--
-- Rather than turn `fetch_types` on (it is off for a reason), the function returns a delimited string and the
-- TS layer splits it. A comma is unambiguous: `orgs_slug_format` (0069) restricts a slug to `[a-z0-9-]`, so a
-- slug can never contain one. Empty stays empty — `array_to_string` of no rows is '', which splits to [].
drop function user_org_directory();

create function user_org_directory()
  returns table (org_id uuid, slug text, former_slugs text, name text, role text)
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select m.org_id,
           o.slug::text,
           coalesce(
             (select string_agg(h.slug::text, ',' order by h.retired_at desc)
                from org_slug_history h
               where h.org_id = o.id and h.slug <> o.slug),
             ''
           ),
           o.name,
           m.role
      from memberships m
      join orgs o on o.id = m.org_id
     where m.user_id = current_app_user()
     order by m.created_at asc, m.org_id asc
  $$;

grant execute on function user_org_directory() to webhook_app;

-- migrate:down

drop function if exists user_org_directory();

create function user_org_directory()
  returns table (org_id uuid, slug text, former_slugs text[], name text, role text)
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select m.org_id,
           o.slug::text,
           coalesce(
             (select array_agg(h.slug::text order by h.retired_at desc)
                from org_slug_history h
               where h.org_id = o.id and h.slug <> o.slug),
             '{}'::text[]
           ),
           o.name,
           m.role
      from memberships m
      join orgs o on o.id = m.org_id
     where m.user_id = current_app_user()
     order by m.created_at asc, m.org_id asc
  $$;

grant execute on function user_org_directory() to webhook_app;
