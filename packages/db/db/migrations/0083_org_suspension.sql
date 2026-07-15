-- migrate:up

-- Org suspension state — the durable "this org is disabled, but not deleted" flag.
--
-- PR2b needs an authoritative way to take an org OUT of service without destroying it: the free-org-cap
-- reconciler suspends the overflow org(s) when a user downgrades a paid org back to Free and now owns more
-- than the allowed number of Free orgs. "Suspended" here is broader than the ingest pause (`ingest_paused`,
-- which stops only INBOUND capture): a suspended org's dashboard is read-only and its OUTBOUND delivery is
-- held too. The two dimensions compose — the reconciler will set `ingest_paused.reason='free_org_cap'` for the
-- ingest 429 AND `orgs.status='suspended'` for the read/delivery gates — so this migration owns only the
-- read/delivery half; the ingest edge stays exactly as it is.
--
-- The row IS the state: there is no separate "suspensions" table. `status` gates; `suspended_reason` explains
-- (for the read-only screen + audit); `suspended_at` timestamps; `restore_deadline` is the informational
-- "restore-by" date shown to the user (a later slice hard-deletes past it — that retention job is NOT here).

alter table orgs
  add column status text not null default 'active',
  add column suspended_reason text,
  add column suspended_at timestamptz,
  add column restore_deadline timestamptz;

-- Only the two states exist today. A CHECK (not an enum) keeps it cheaply extensible (e.g. a future
-- 'pending_deletion') without an ALTER TYPE.
alter table orgs
  add constraint orgs_status_check check (status in ('active', 'suspended'));

-- Coherence: an active org carries NO suspension metadata; a suspended org MUST carry a reason + timestamp.
-- This makes "suspended but we don't know why/when" unrepresentable, so the read screen + audit always have
-- their inputs. `restore_deadline` is intentionally NOT constrained — a suspension may or may not set one.
alter table orgs
  add constraint orgs_suspension_coherent check (
    (status = 'active' and suspended_reason is null and suspended_at is null)
    or
    (status = 'suspended' and suspended_reason is not null and suspended_at is not null)
  );

-- webhook_app already holds a table-wide grant on `orgs` (0003), so the new columns are readable by the web
-- read gate and the delivery drain with no further grant. The one place that must learn about `status` is the
-- cross-org directory the read gate resolves through: thread `status` + `suspended_reason` into
-- `user_org_directory()` so a single per-request directory read tells the gate whether the org is suspended
-- (and why) without a second query. Everything else in the function is byte-identical to 0070.
drop function user_org_directory();

create function user_org_directory()
  returns table (
    org_id uuid,
    slug text,
    former_slugs text,
    name text,
    role text,
    status text,
    suspended_reason text
  )
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
           m.role,
           o.status,
           o.suspended_reason
      from memberships m
      join orgs o on o.id = m.org_id
     where m.user_id = current_app_user()
     order by m.created_at asc, m.org_id asc
  $$;

grant execute on function user_org_directory() to webhook_app;

-- migrate:down

-- Restore the 0070 signature (no status/suspended_reason columns in the result).
drop function if exists user_org_directory();

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

alter table orgs drop constraint orgs_suspension_coherent;
alter table orgs drop constraint orgs_status_check;
alter table orgs
  drop column restore_deadline,
  drop column suspended_at,
  drop column suspended_reason,
  drop column status;
