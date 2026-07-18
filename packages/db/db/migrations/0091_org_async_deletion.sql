-- migrate:up

-- Async org deletion (#665, follow-up to #635). Deleting an org's whole Postgres tree synchronously is one
-- unbounded `delete from orgs` cascade over events + delivery_attempts: at extreme volume it can exceed the
-- statement/transaction timeout (making the biggest orgs undeletable), and any row ingested during the delete
-- is swept under the per-org audit advisory lock. #635 moved that work off the lock and kept it atomic, but
-- it is still one synchronous long delete. This migration lays the foundation for an ASYNC drain that mirrors
-- the R2 payload purge (0051): the delete is REQUESTED synchronously (mark the org `deleting` + append the
-- audit row + enqueue), and a cross-org cron reaps the tenant rows in bounded, resumable chunks.
--
-- This migration is INERT until the sync path is flipped to mark-deleting and the `webhook_reaper` role is
-- provisioned + its cron enabled — nothing here changes existing behaviour on its own.

-- 1) The `deleting` status. 0083 deliberately used a CHECK (not an enum) "to keep it cheaply extensible
--    (e.g. a future 'pending_deletion') without an ALTER TYPE" — this is that extension. `deleting_at`
--    timestamps the request (the reaper claims oldest-first). Suspension metadata is cleared on transition.
alter table orgs add column deleting_at timestamptz;

alter table orgs drop constraint orgs_status_check;
alter table orgs add constraint orgs_status_check check (status in ('active', 'suspended', 'deleting'));

-- Coherence across all three states: active carries no metadata; suspended carries reason+timestamp;
-- deleting carries deleting_at (and no suspension metadata — a deleting org is past suspension). Makes
-- "deleting but we don't know since when" unrepresentable, mirroring 0083's suspension coherence.
alter table orgs drop constraint orgs_suspension_coherent;
alter table orgs add constraint orgs_lifecycle_coherent check (
  (status = 'active' and suspended_reason is null and suspended_at is null and deleting_at is null)
  or
  (status = 'suspended' and suspended_reason is not null and suspended_at is not null and deleting_at is null)
  or
  (status = 'deleting' and deleting_at is not null and suspended_reason is null and suspended_at is null)
);

-- 2) Hide a `deleting` org from the user-facing directory. The web READ/auth gate resolves the slug through
--    this function, so filtering here 404s a deleting org for every dashboard surface (no per-page change).
--    But `deleting` is a new lifecycle STATE, not only a visibility flag: the surfaces that read orgs.status
--    DIRECTLY — outbound delivery (isOrgDeliveryHeld), the free-org-cap count, the API-key gate (revoked in
--    requestOrgDeletion), and the OrgStatus type — are each handled explicitly alongside this. The reaper
--    reads orgs directly (below), not through this function. Signature unchanged from 0083.
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
       and o.status <> 'deleting'
     order by m.created_at asc, m.org_id asc
  $$;

grant execute on function user_org_directory() to webhook_app;

-- 3) The reaper claims oldest-first; a partial index keeps that scan index-driven (mirrors
--    org_deletions_purging_idx from 0051).
create index orgs_deleting_idx on orgs (deleting_at) where status = 'deleting';

-- 4) webhook_reaper: the cross-org engine cron that drains a `deleting` org's events in chunks, then drops
--    the org row. Least privilege: it can SELECT the id/status/deleting_at of deleting orgs (to claim +
--    order), DELETE their events, and DELETE the org row itself — nothing else, and every grant is fenced
--    behind `status = 'deleting'` by RLS so a set-the-wrong-GUC bug can never touch a live org. It does NOT
--    need DELETE on delivery_attempts: deleting an event CASCADES its delivery_attempts via the composite FK
--    (0003:202), executed by the FK system regardless of the reaper's table privileges — the exact mechanism
--    webhook_retention (0053) relies on. Created password-less like the other cron roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_reaper') then
    create role webhook_reaper login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;
grant usage on schema public to webhook_reaper;

-- Column-scoped SELECT: enumerate deleting orgs (id) + order (deleting_at); status is read by the claim
-- predicate. It deliberately CANNOT read slug/name/billing/etc.
grant select (id, status, deleting_at) on orgs to webhook_reaper;
grant delete on orgs to webhook_reaper;
-- On events: SELECT only (id, org_id) — enough to pick a bounded chunk by id — plus DELETE. It deliberately
-- CANNOT read the payload key/headers/etc. (unlike webhook_retention, which needs the R2 key to purge).
grant select (id, org_id) on events to webhook_reaper;
grant delete on events to webhook_reaper;

-- IMPORTANT — RESTRICTIVE fences, not permissive. The base 0003 policies (events_delete, orgs_delete, …) are
-- `to public`, so they ALSO apply to webhook_reaper and grant `org_id = current_org_id()` regardless of
-- status. A new PERMISSIVE policy only OR's more access on — it can never subtract. So the `status='deleting'`
-- fence is expressed as RESTRICTIVE policies, which AND with the permissive ones: the reaper can touch a row
-- only if the base policy allows it (it's the current tenant) AND the org is `deleting`. Pinned at a live org
-- via a wrong GUC, the reaper therefore sees and deletes nothing.

-- The claim is a CROSS-org read with no GUC, so the base GUC-scoped policies show nothing; this PERMISSIVE
-- policy is what lets the reaper enumerate every deleting org (and back the `exists` fences below).
create policy orgs_reaper_select on orgs
  for select to webhook_reaper using (status = 'deleting');

-- RESTRICTIVE: the reaper may SELECT/DELETE an org's events only while that org is deleting. Split per-command
-- (not `for all`) so the RLS catalog guard still sees exactly the four command kinds. current_org_id() is
-- constant per statement, so the `exists` guard is evaluated once, not per row.
create policy events_reaper_select_fence on events
  as restrictive for select to webhook_reaper using (
    exists (select 1 from orgs where id = current_org_id() and status = 'deleting')
  );
create policy events_reaper_delete_fence on events
  as restrictive for delete to webhook_reaper using (
    exists (select 1 from orgs where id = current_org_id() and status = 'deleting')
  );

-- RESTRICTIVE: the reaper may DELETE only a deleting org's row (the finalize). Combines with the base
-- orgs_delete permissive (id = current_org_id()).
create policy orgs_reaper_fence on orgs
  as restrictive for delete to webhook_reaper using (status = 'deleting');

-- migrate:down

drop policy if exists orgs_reaper_fence on orgs;
drop policy if exists events_reaper_delete_fence on events;
drop policy if exists events_reaper_select_fence on events;
drop policy if exists orgs_reaper_select on orgs;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_reaper') then
    revoke select (id, status, deleting_at), delete on orgs from webhook_reaper;
    revoke select (id, org_id), delete on events from webhook_reaper;
    revoke usage on schema public from webhook_reaper;
    drop role webhook_reaper;
  end if;
end
$$;

drop index if exists orgs_deleting_idx;

-- Restore the 0083 directory function (no deleting filter).
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

-- Any org left in `deleting` can't stay in a status the restored 2-state CHECK forbids. REVERT it to `active`
-- (deleting_at cleared; suspension metadata was already cleared on the deleting transition, so this satisfies
-- the restored orgs_suspension_coherent). Deliberately NOT `delete from orgs` — that would re-introduce the
-- unbounded synchronous cascade the reaper exists to avoid, and a timeout mid-rollback would leave the schema
-- half-reverted. Reverting is non-destructive and cheap. (In practice there are none: the feature ships inert;
-- its endpoints/credentials were revoked, so a reverted org is inert until an operator restores it.)
update orgs set status = 'active', deleting_at = null where status = 'deleting';

alter table orgs drop constraint orgs_lifecycle_coherent;
alter table orgs add constraint orgs_suspension_coherent check (
  (status = 'active' and suspended_reason is null and suspended_at is null)
  or
  (status = 'suspended' and suspended_reason is not null and suspended_at is not null)
);
alter table orgs drop constraint orgs_status_check;
alter table orgs add constraint orgs_status_check check (status in ('active', 'suspended'));
alter table orgs drop column deleting_at;
