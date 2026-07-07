-- migrate:up

-- S4.1 metering-finalization + the cross-org enumeration role. Two money-correctness
-- properties on top of the derived rollup (0007):
--   1. usage.finalized_at freezes a closed day's count into an immutable billing snapshot.
--      rollup_usage is re-created to SKIP a finalized row on conflict, so a recount after
--      events are pruned can never make a billed number silently decrease (F1).
--   2. webhook_meter: a least-privilege, cross-org enumeration role (the anchor/reconciler/
--      notifier pattern) so the rollup cron can discover which orgs have recent events (or a
--      stale-open usage day) WITHOUT bypassing RLS. Read-only, column-scoped to the
--      enumeration keys — never any payload/dedup/header content.

alter table usage add column finalized_at timestamptz;
comment on column usage.finalized_at is
  'When set, this day''s event_count is frozen (an immutable billing snapshot): the rollup never recounts it, so a later events-retention prune cannot make a billed count decrease. NULL = still open/recounted.';

-- Money-integrity, DB-enforced (defense-in-depth). The rollup already skips a finalized row
-- (the on-conflict guard below), but webhook_app holds table-level UPDATE on usage, so make
-- the snapshot immutable at the database layer regardless of which role/path writes: once
-- finalized_at is set, neither event_count nor finalized_at may change (append-only). The
-- legitimate freeze (null -> now()) and open-day recounts still pass — they act on rows whose
-- OLD.finalized_at is null, so the guard never fires on them.
create function usage_finalized_immutable() returns trigger
  language plpgsql
  as $$
begin
  if old.finalized_at is not null
     and (new.event_count is distinct from old.event_count
          or new.finalized_at is distinct from old.finalized_at) then
    raise exception 'usage row (org %, window %) is finalized and immutable', old.org_id, old.window_start
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger usage_finalized_immutable_bu before update on usage
  for each row execute function usage_finalized_immutable();

-- Support the metering cron's cross-org "orgs with recent events" enumeration
-- (select distinct org_id from events where received_at >= $1) without a full scan of the
-- highest-volume table. received_at is append-ordered (server-stamped ~now()), so a BRIN index
-- is tiny and near-free to maintain on the ingest path — the right tool for a range scan over
-- the recent tail (a btree would add real per-insert write cost the hot path can't afford).
create index events_received_at_brin on events using brin (received_at);

-- Re-create rollup_usage (0007) with the finalized guard: on conflict, update ONLY an open
-- row. A frozen row (finalized_at not null) is left intact even if called for its window.
-- Everything else is identical to 0007 (day-truncated, security invoker, RLS-per-org).
create or replace function rollup_usage(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into usage (org_id, window_start, event_count, updated_at)
  select e.org_id, v_window, count(*), now()
  from events e
  where e.received_at >= v_window
    and e.received_at < v_window + interval '1 day'
  group by e.org_id
  on conflict (org_id, window_start)
  do update set event_count = excluded.event_count, updated_at = now()
    where usage.finalized_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

grant execute on function rollup_usage(timestamptz) to webhook_app;

-- The cross-org enumeration role. NON-OWNER, NOSUPERUSER, NOBYPASSRLS; created idempotently
-- and password-less (mirrors 0033/0034 — ops injects the login password out of band in a
-- managed environment). The rollup + freeze run PER-ORG under webhook_app RLS; this role only
-- ever answers "which orgs have work?" and holds no write anywhere.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_meter') then
    create role webhook_meter login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_meter;

-- Role-targeted SELECT policies (FOR SELECT TO webhook_meter only — never a bare policy
-- webhook_app could ride): enumerate orgs with recent events, and orgs with a stale-open
-- usage day still needing a freeze. webhook_app's per-org policies are untouched.
create policy events_meter_select on events
  for select to webhook_meter using (true);
create policy usage_meter_select on usage
  for select to webhook_meter using (true);

-- COLUMN grants (least privilege). events: ONLY the enumeration keys — never a payload,
-- header, or dedup column. usage: the freeze-enumeration keys.
grant select (org_id, received_at) on events to webhook_meter;
grant select (org_id, window_start, finalized_at) on usage to webhook_meter;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_meter') then
    revoke select (org_id, window_start, finalized_at) on usage from webhook_meter;
    revoke select (org_id, received_at) on events from webhook_meter;
    drop policy if exists usage_meter_select on usage;
    drop policy if exists events_meter_select on events;
    revoke usage on schema public from webhook_meter;
    drop role webhook_meter;
  end if;
end
$$;

-- Restore rollup_usage to its 0007 definition (no finalized guard).
create or replace function rollup_usage(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into usage (org_id, window_start, event_count, updated_at)
  select e.org_id, v_window, count(*), now()
  from events e
  where e.received_at >= v_window
    and e.received_at < v_window + interval '1 day'
  group by e.org_id
  on conflict (org_id, window_start)
  do update set event_count = excluded.event_count, updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

drop index if exists events_received_at_brin;
drop trigger if exists usage_finalized_immutable_bu on usage;
drop function if exists usage_finalized_immutable();
alter table usage drop column finalized_at;
