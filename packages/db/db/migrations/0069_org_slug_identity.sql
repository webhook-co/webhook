-- migrate:up

-- `orgs.slug` becomes a real identifier: constrained, short, renameable, and NEVER recycled.
--
-- Until now it has been a WRITE-ONLY column — `citext not null unique` and nothing in the repo reads it. It
-- is about to become the org's URL (`/org/{slug}/…`), which is a very different job, and it has none of the
-- invariants that job needs: no format check, no length cap, no reserved-word guard, and no rename path.
--
-- Four things, in an order that matters:
--   1. BACKFILL every existing slug to the new short shape (free — zero readers today).
--   2. CHECK the format. It must come AFTER the backfill: adding a CHECK validates against existing rows, and
--      every slug in prod today is the old ~45-char `<name>-<32-char auth user id>` shape, which the new
--      constraint rejects. Constraint-first would abort the migration.
--   3. A RESERVED-WORD denylist, so a slug can never shadow a route segment (`/org/new`, `/org/settings`).
--   4. `org_slug_history` + a trigger, so a retired slug can NEVER be claimed by another org.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Backfill
-- ---------------------------------------------------------------------------------------------------------
--
-- ⚠️ `orgs` is FORCE ROW LEVEL SECURITY, which means the table OWNER is policed too — that is the whole point
-- of FORCE, and `rls.test.ts` asserts it. So a migration running as webhook_owner sees ZERO rows through
-- `orgs_select` (`id = current_org_id()`, and the GUC is unset here). A backfill that "worked" would silently
-- update nothing. `row_security = off` is not an escape either: with FORCE, Postgres raises rather than
-- bypassing. RLS is therefore turned off for the length of this one statement and restored immediately —
-- inside the migration's transaction, so it is never observable to another session.
alter table orgs disable row level security;

do $$
declare
  r record;
  base text;
  candidate citext;
  n int;
begin
  for r in select id, name from orgs loop
    -- The same shape apps/auth's personalOrgSlug produces: a capped name-ish base, then a short digest.
    base := regexp_replace(lower(coalesce(r.name, '')), '[^a-z0-9]+', '-', 'g');
    base := regexp_replace(base, '^-+|-+$', '', 'g');
    base := left(base, 16);
    base := regexp_replace(base, '-+$', '', 'g');   -- left() can land on a hyphen
    if base = '' then base := 'org'; end if;

    n := 0;
    loop
      candidate := base || '-' || substr(md5(r.id::text || n::text), 1, 6);
      exit when not exists (select 1 from orgs o where o.slug = candidate and o.id <> r.id);
      n := n + 1;
      if n > 50 then
        raise exception 'org %: no free slug after % attempts', r.id, n;
      end if;
    end loop;

    update orgs set slug = candidate where id = r.id;
  end loop;
end $$;

alter table orgs enable row level security;
alter table orgs force row level security;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Format
-- ---------------------------------------------------------------------------------------------------------
--
-- 3–40 chars; lowercase alphanumeric and hyphens; no leading or trailing hyphen. And NEVER all-numeric, which
-- keeps a future `/org/{idOrSlug}` polymorphic route unambiguous — a cheap invariant now, impossible to add
-- later without breaking whoever grabbed `/org/12345`.
--
-- ⚠️ The `::text` cast on the REGEX is load-bearing, and it is a genuine trap. `slug` is **citext**, and
-- citext overloads `~` to be case-INSENSITIVE — so `slug ~ '^[a-z0-9]…'` happily accepts `ACME-Corp`. That is
-- not a guess: the constraint was written without the cast first, and an uppercase slug went straight in.
-- `(slug)::text ~ …` restores case-sensitive matching and actually pins the invariant.
--
-- (The `= lower(…)` clause below is belt-and-braces. It would have worked either way — `lower(citext)` returns
-- text, so that comparison is already case-sensitive — but it states the intent where a reader will look.)
--
-- It matters because the slug is a URL. Without it, `/org/ACME-Corp/` and `/org/acme-corp/` are two URLs for
-- one org, and the app's JS `===` (case-sensitive) disagrees with the DB's `=` (not) — the exact seam where a
-- resolver and an authorization check drift apart.
alter table orgs
  add constraint orgs_slug_format
  check (
    slug::text ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    and slug::text !~ '^[0-9]+$'
    and slug::text = lower(slug::text)
  );

-- ---------------------------------------------------------------------------------------------------------
-- 3. Reserved words
-- ---------------------------------------------------------------------------------------------------------
--
-- A slug that shadows a route segment makes the router ambiguous: `/org/new` must mean "create an org", not
-- "the org called new". The denylist is every top-level segment under `/org/{slug}/`, plus the brand and infra
-- names nobody should be able to squat. IMMUTABLE, so it may be used in a CHECK.
create function org_slug_reserved(s citext) returns boolean
  language sql
  immutable
  as $$
    select s in (
      -- route segments under /org/{slug}/
      'dashboard', 'endpoints', 'events', 'deliveries', 'destinations', 'triggers',
      'credentials', 'settings', 'team', 'billing', 'usage', 'audit',
      -- routing + creation
      'org', 'orgs', 'new', 'api', 'admin', 'login', 'logout', 'auth', 'invite',
      -- framework / infra
      'static', '_next', 'well-known',
      -- brand + surfaces
      'webhook', 'wbhk', 'www', 'app', 'docs', 'play', 'get', 'status', 'support', 'help',
      'pricing', 'blog', 'security', 'legal'
    )
  $$;
comment on function org_slug_reserved(citext) is
  'A slug that would shadow a route segment, surface, or brand name. Used by the orgs_slug_not_reserved CHECK.';

alter table orgs
  add constraint orgs_slug_not_reserved
  check (not org_slug_reserved(slug));

-- ---------------------------------------------------------------------------------------------------------
-- 4. Rename history — and why a retired slug is NEVER recycled
-- ---------------------------------------------------------------------------------------------------------
--
-- Renaming an org must keep its old URLs working, so every retired slug is kept and 308s to the current one.
-- The load-bearing part is that a retired slug can never be CLAIMED BY ANOTHER ORG. That is not a nicety: it
-- is GitHub's documented account-takeover bug — after an org renames, its old name becomes available, and
-- whoever takes it can create resources that override the original's redirects. Anyone still following an old
-- link lands on the attacker's org. So: retired slugs are cheap rows, and they are kept forever.
--
-- 🔴 THE DATABASE WRITES THIS TABLE. THE APPLICATION NEVER DOES. That is not fastidiousness — the first cut
-- let webhook_app INSERT its own history rows, gated by `with check (org_id = current_org_id())`, and it is a
-- **namespace-squatting hole**, verified by exploit before it was closed:
--
--   1. the attacker inserts (slug => 'acme', org_id => THEIR OWN org) — nothing required them to have ever
--      held 'acme'; the WITH CHECK only constrains the org_id column, not the truthfulness of the slug;
--   2. the guard below then refuses 'acme' to EVERY other org, forever;
--   3. and the attacker can still take it themselves, since reclaiming your own retired slug is allowed.
--
-- Forge a row per desirable name and you have permanently denied the entire namespace. The WITH CHECK looked
-- like tenancy and was really just "tag it with your own id" — the classic mistake of validating the column
-- you thought of instead of the claim being made.
--
-- So history is DERIVED, never asserted: a trigger records the old slug on rename, and on delete. webhook_app
-- gets SELECT only — no INSERT, no UPDATE, no DELETE — so there is no statement it can issue that puts a row
-- in this table at all.
create table org_slug_history (
  slug       citext primary key,
  -- NULLABLE, with ON DELETE SET NULL rather than CASCADE. If deleting an org CASCADED its history away, its
  -- slugs would become claimable again — and anyone still following an old link would land on whoever grabbed
  -- them. That is the same takeover, merely requiring the victim to delete first. A retired slug outlives the
  -- org that retired it; the row simply stops naming one.
  org_id     uuid references orgs (id) on delete set null,
  retired_at timestamptz not null default now()
);
create index org_slug_history_org_id_idx on org_slug_history (org_id);

alter table org_slug_history enable row level security;
alter table org_slug_history force row level security;

-- SELECT only, and only your own. There is deliberately NO insert/update/delete policy and NO such grant: the
-- table is written exclusively by the triggers below, which run as the definer.
create policy org_slug_history_tenant on org_slug_history
  for select to webhook_app
  using (org_id = current_org_id());
grant select on org_slug_history to webhook_app;

-- The definer-only view: unrestricted, scoped `to webhook_owner`, so ONLY a SECURITY DEFINER function owned by
-- it can evaluate this policy. The guard genuinely needs to see EVERY org's retired slugs — one that could
-- only see its own tenant's history could not tell you a slug was retired by someone else, which is precisely
-- the case it exists to refuse.
create policy org_slug_history_definer on org_slug_history
  for all to webhook_owner
  using (true) with check (true);

-- The guard. SECURITY DEFINER for the reason above.
--
-- `is distinct from`, not `<>`: a retired slug whose org has since been DELETED has a NULL org_id, and
-- `NULL <> new.id` evaluates to NULL — not true — so the EXISTS would not match and the slug would quietly
-- become claimable again. Exactly the case the nullable column exists to prevent. `is distinct from` is
-- null-safe and refuses it.
create function orgs_slug_not_retired() returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $$
  begin
    if exists (
      select 1 from org_slug_history h
       where h.slug = new.slug and h.org_id is distinct from new.id
    ) then
      raise exception 'slug % was retired and can never be reused', new.slug
        using errcode = 'unique_violation';
    end if;
    return new;
  end;
  $$;

-- `unique_violation` (23505) deliberately: to every caller this IS a taken slug, and the bootstrap's
-- collision retry already recognises that SQLSTATE. A bespoke error code would make it retry nothing.
create trigger orgs_slug_not_retired_trg
  before insert or update of slug on orgs
  for each row execute function orgs_slug_not_retired();

-- History is RECORDED BY THE DATABASE, on the events that actually retire a slug — a rename, and a delete.
-- The app cannot write it, and therefore cannot lie about it. `on conflict do nothing` because an org
-- reclaiming its own former slug leaves that row already present.
create function orgs_slug_record_history() returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $$
  begin
    if tg_op = 'DELETE' then
      insert into org_slug_history (slug, org_id) values (old.slug, old.id)
        on conflict (slug) do nothing;
      return old;
    end if;
    if new.slug is distinct from old.slug then
      insert into org_slug_history (slug, org_id) values (old.slug, old.id)
        on conflict (slug) do nothing;
    end if;
    return new;
  end;
  $$;

create trigger orgs_slug_record_history_trg
  after update of slug on orgs
  for each row execute function orgs_slug_record_history();

-- BEFORE delete, so the row lands while the org still exists (the FK is satisfied); the ON DELETE SET NULL
-- then nulls it as the org goes. A deleted org's slugs stay retired — nobody inherits its URLs.
create trigger orgs_slug_record_history_on_delete_trg
  before delete on orgs
  for each row execute function orgs_slug_record_history();

-- ---------------------------------------------------------------------------------------------------------
-- 5. The directory learns the slug — and therefore how to RESOLVE one
-- ---------------------------------------------------------------------------------------------------------
--
-- 🔑 This is the security keystone of the whole `/org/{slug}` move, so it is worth being explicit about why it
-- looks like this.
--
-- A GLOBAL slug -> org_id lookup is STRUCTURALLY IMPOSSIBLE for webhook_app, and deliberately so: its only
-- SELECT policy on `orgs` is `id = current_org_id()`, i.e. you may only ask about an org you can already name.
-- A `select id from orgs where slug = $1` therefore returns ZERO rows — silently, not with an error, which is
-- the dangerous kind of wrong. And the "obvious" fix (a permissive policy so webhook_app can look any slug up)
-- is precisely the privilege escalation migration 0067 was written to eliminate: Postgres policies are
-- PERMISSIVE and OR together, so from that moment every un-scoped read by the request-path role is cross-org.
--
-- So the slug is resolved INSIDE THE CALLER'S OWN DIRECTORY. `user_org_directory()` already returns exactly
-- the orgs this user belongs to, bounded by `current_app_user()`. Adding `slug` (and the org's former slugs)
-- means the app resolves a URL segment by scanning that list — which makes **slug resolution and the
-- membership check THE SAME OPERATION**. They cannot drift apart, because there is only one of them. And a
-- slug you are not a member of is indistinguishable from one that does not exist, so there is no enumeration
-- oracle to close later: there is none by construction.
--
-- A return-type change requires DROP + CREATE (Postgres cannot alter it in place), and the grant must be
-- re-issued because the drop takes it with it.
drop function user_org_directory();

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
               where h.org_id = o.id),
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

-- migrate:down

drop function if exists user_org_directory();
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

drop trigger if exists orgs_slug_record_history_on_delete_trg on orgs;
drop trigger if exists orgs_slug_record_history_trg on orgs;
drop function if exists orgs_slug_record_history();
drop trigger if exists orgs_slug_not_retired_trg on orgs;
drop function if exists orgs_slug_not_retired();
drop table if exists org_slug_history;
alter table orgs drop constraint if exists orgs_slug_not_reserved;
drop function if exists org_slug_reserved(citext);
alter table orgs drop constraint if exists orgs_slug_format;
