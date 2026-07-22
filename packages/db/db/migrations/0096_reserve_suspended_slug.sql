-- migrate:up

-- Reserve the `suspended` org slug.
--
-- WHY IT WAS MISSING, AND WHY THAT IS A REAL GAP. `suspended` is a top-level route segment under
-- `/org/{slug}/` (the read-only suspension screen), so it is in `MOVED_SEGMENTS` (apps/web
-- legacy-redirect.ts) — but it postdates migration 0069, which is where every OTHER route segment
-- (`dashboard`, `endpoints`, `billing`, …) was reserved. So the one route segment that shipped after 0069
-- is the one segment a user could register as an org slug. That is the exact shape a `MOVED_SEGMENTS ⊆
-- ORG_SLUG_RESERVED` guard exists to prevent (added alongside this in apps/web); reserving it here closes
-- the DB half.
--
-- `org_slug_reserved` is IMMUTABLE and consumed by the `orgs_slug_not_reserved` CHECK. Postgres does NOT
-- re-validate an existing CHECK when the function it calls is replaced, so if an org already HOLDS
-- `suspended`, this `create or replace` would silently leave that row in violation — enforced by nothing
-- until a dump/restore or an explicit VALIDATE, at which point it fails far from here. The guard below turns
-- that silent, deferred failure into a loud one AT APPLY TIME: the deploy aborts with a clear message
-- instead of shipping an inconsistency. (Verified against the real DB by org-slug-parity.test.ts, which
-- applies this migration, and by mig0096-guard.test.ts, which asserts the guard actually RAISES.)
--
-- ⚠️ `orgs` is FORCE ROW LEVEL SECURITY, so the migration role is policed too: a bare `select from orgs`
-- here sees ZERO rows through `orgs_select` (`id = current_org_id()`, GUC unset) and the guard would be a
-- silent no-op — the exact latent-lie shape migration 0069 documents. Turn RLS off for the length of this
-- check and restore it immediately; it is all one transaction, so this is never observable to another
-- session and a raise rolls the disable back too.
alter table orgs disable row level security;

do $$
begin
  if exists (select 1 from orgs where slug = 'suspended'::citext) then
    raise exception
      'cannot reserve slug "suspended": an org already holds it. Rename that org first, then re-run.';
  end if;
end
$$;

alter table orgs enable row level security;
alter table orgs force row level security;

create or replace function org_slug_reserved(s citext) returns boolean
  language sql
  immutable
  as $$
    select s in (
      -- route segments under /org/{slug}/
      'dashboard', 'endpoints', 'events', 'deliveries', 'destinations', 'triggers',
      'credentials', 'settings', 'team', 'billing', 'usage', 'audit', 'suspended',
      -- routing + creation
      'org', 'orgs', 'new', 'api', 'admin', 'login', 'logout', 'auth', 'invite',
      -- framework / infra
      'static', '_next', 'well-known',
      -- brand + surfaces
      'webhook', 'wbhk', 'www', 'app', 'docs', 'play', 'get', 'status', 'support', 'help',
      'pricing', 'blog', 'security', 'legal'
    )
  $$;

-- migrate:down

create or replace function org_slug_reserved(s citext) returns boolean
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
