-- migrate:up

-- Decouple the two append-only WORM audit trails from the orgs FK so an org can be
-- hard-deleted without the ON DELETE CASCADE firing the row-level `no_delete` triggers
-- (which raise and abort the whole delete) and destroying the tamper-evident, R2-anchored
-- hash chain. The rows are retained by design: `actor` is a non-PII pseudonymous user id
-- (0005:15-16, 0013:80), and org_id stays as a plain (now unreferenced) column so per-org
-- RLS and the per-org `seq` chain are unchanged. See the data-migration skill: never delete
-- hash-chained audit history.
alter table audit_log drop constraint if exists audit_log_org_id_fkey;
alter table auth_audit_event drop constraint if exists auth_audit_event_org_id_fkey;

-- Completion-tracked state for the durable R2 payload purge that follows an org delete.
-- Deliberately NOT foreign-keyed to orgs: this row outlives the org it describes. One row
-- per deleted org; the engine purge cron advances `r2_cursor`/`objects_purged` until
-- list('org/{org_id}/') is exhausted, then flips to 'completed'.
create table org_deletions (
  org_id uuid primary key,
  status text not null default 'purging' check (status in ('purging', 'completed')),
  r2_cursor text,
  objects_purged bigint not null default 0,
  requested_by text,
  requested_at timestamptz not null default now(),
  purge_completed_at timestamptz
);

alter table org_deletions enable row level security;
alter table org_deletions force row level security;

-- webhook_app inserts the job in the same transaction as the org delete (org_id is its
-- RLS-pinned org) and may read back only its own org's job; it never mutates or deletes it.
-- The insert `with check` is the security boundary: a tenant cannot enqueue a purge for an
-- org that isn't theirs (which would otherwise let it destroy another org's R2 payloads).
grant insert, select on org_deletions to webhook_app;
create policy org_deletions_app_insert on org_deletions
  for insert to webhook_app with check (org_id = current_org_id());
create policy org_deletions_app_select on org_deletions
  for select to webhook_app using (org_id = current_org_id());

-- webhook_purge: the cross-org engine cron that drains the R2 purge. SELECT to find
-- outstanding jobs, column-scoped UPDATE to advance the cursor/counters/completion. No
-- INSERT, no DELETE, and no access to any tenant table (least privilege; catalog-tested).
-- Created password-less (Neon injects the password out of band), like the other cron roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_purge') then
    create role webhook_purge login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;
grant usage on schema public to webhook_purge;
-- Column-scoped SELECT: the drain reads only the columns it needs — org_id/status/r2_cursor to
-- enumerate + resume, requested_at to order, and objects_purged because the running-total UPDATE
-- (`objects_purged = objects_purged + n`) reads it. It deliberately CANNOT read requested_by (a
-- cross-tenant pseudonymous actor) or purge_completed_at — least privilege, mirroring the
-- anchor/meter roles' column-scoped cross-org reads.
grant select (org_id, status, r2_cursor, requested_at, objects_purged) on org_deletions to webhook_purge;
grant update (status, r2_cursor, objects_purged, purge_completed_at) on org_deletions to webhook_purge;
create policy org_deletions_purge_select on org_deletions
  for select to webhook_purge using (true);
create policy org_deletions_purge_update on org_deletions
  for update to webhook_purge using (status = 'purging') with check (status in ('purging', 'completed'));

-- The drain scans outstanding jobs oldest-first; partial index keeps it index-driven.
create index org_deletions_purging_idx on org_deletions (requested_at) where status = 'purging';

-- migrate:down

drop index if exists org_deletions_purging_idx;
drop policy if exists org_deletions_purge_update on org_deletions;
drop policy if exists org_deletions_purge_select on org_deletions;
drop policy if exists org_deletions_app_select on org_deletions;
drop policy if exists org_deletions_app_insert on org_deletions;
revoke all on org_deletions from webhook_purge;
revoke all on org_deletions from webhook_app;
drop table if exists org_deletions;
revoke usage on schema public from webhook_purge;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_purge') then
    drop role webhook_purge;
  end if;
end
$$;

-- Restore the audit FKs (matches the 0005 / 0013 definitions) for a clean reversal.
alter table audit_log add constraint audit_log_org_id_fkey
  foreign key (org_id) references orgs (id) on delete cascade;
alter table auth_audit_event add constraint auth_audit_event_org_id_fkey
  foreign key (org_id) references orgs (id) on delete cascade;
