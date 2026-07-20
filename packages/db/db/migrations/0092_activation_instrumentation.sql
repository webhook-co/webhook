-- migrate:up

-- Activation & funnel instrumentation (marketing measurement layer). Makes "weekly activated developers"
-- — and the funnel signup -> first capture -> first forward — a real, queryable, privacy-safe number.
--
-- DERIVED, not emitted. There is no counter on any hot path (constitution): first-capture is MIN of
-- events.received_at; first-forward is MIN of delivery_attempts.created_at WHERE status='forwarded' — which
-- is UNIQUELY the localhost-tunnel writer (packages/db/src/replay.ts: the CLI POSTs to localhost and only
-- after a local 2xx records this row; automated server deliveries use queued/pending -> delivered/failed).
-- Two SECURITY INVOKER rollup fns run per-tenant under webhook_app RLS (mirroring rollup_delivery_stats,
-- 0063); a cron (apps/engine) enumerates active orgs cross-org as webhook_meter and calls them per org.
--
-- Storage: durable Postgres is authoritative — the metric needs exact distinct counts, a >90-day trend, and
-- an identity join, none of which Analytics Engine can do (estimate store, 90-day retention, id-labels
-- forbidden by ADR-0125). A durable snapshot is JUSTIFIED because per-plan retention (0054) purges
-- events/delivery_attempts before a weekly trend could be reconstructed; milestones are set-once/monotonic
-- and weekly-activity flags OR-accumulate, so both survive source pruning.
--
-- Cross-org read (the founder's weekly review) is confined to ONE SECURITY DEFINER fn, mirroring
-- user_org_directory (0067): FORCE ROW LEVEL SECURITY means the definer (webhook_owner) is POLICED too, so
-- the `for select to webhook_owner using(true)` policies below BOUND the function rather than let it bypass
-- RLS. It returns AGGREGATES ONLY (no org_id, no PII). Identifiers stay in-CF/Postgres (ADR-0125 in-CF tier).

-- ============================================================================================
-- 1) activation_org_milestones — per-org first-activation state (set-once / monotonic-earliest).
--    signed_up_at + first_touch_* are stamped at signup (apps/auth, non-blocking, PR4); the rollup only
--    ever fills/lowers first_capture_at + first_forward_at.
-- ============================================================================================
create table activation_org_milestones (
  org_id uuid primary key references orgs (id) on delete cascade,
  signed_up_at timestamptz not null,
  first_capture_at timestamptz,
  first_forward_at timestamptz,
  -- Cookieless first-touch acquisition attribution (bounded/normalized UTM strings; never PII). Null when
  -- the signup carried no source. Set once at signup and never overwritten by a later touch.
  first_touch_source text,
  first_touch_medium text,
  first_touch_campaign text,
  updated_at timestamptz not null default now()
);
alter table activation_org_milestones enable row level security;
alter table activation_org_milestones force row level security;
create policy activation_milestones_select on activation_org_milestones for select using (org_id = current_org_id());
create policy activation_milestones_insert on activation_org_milestones for insert with check (org_id = current_org_id());
create policy activation_milestones_update on activation_org_milestones for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy activation_milestones_delete on activation_org_milestones for delete using (org_id = current_org_id());
-- Cross-org read, confined to the SECURITY DEFINER review fn (owner), scoped `to webhook_owner` so no other
-- role can ever evaluate it — webhook_app's view stays exactly `org_id = current_org_id()`. FORCE RLS means
-- the definer is policed by THIS, not bypassing it (the 0067 confinement pattern).
create policy activation_milestones_owner_read on activation_org_milestones for select to webhook_owner using (true);
grant select, insert, update, delete on activation_org_milestones to webhook_app;

-- ============================================================================================
-- 2) activation_org_weekly — per-org per-ISO-week activity (the retention-safe NSM source).
--    captured/forwarded OR-accumulate, so a week's activity, once recorded, survives source pruning.
-- ============================================================================================
create table activation_org_weekly (
  org_id uuid not null references orgs (id) on delete cascade,
  iso_week date not null,
  captured boolean not null default false,
  forwarded boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (org_id, iso_week)
);
alter table activation_org_weekly enable row level security;
alter table activation_org_weekly force row level security;
create policy activation_weekly_select on activation_org_weekly for select using (org_id = current_org_id());
create policy activation_weekly_insert on activation_org_weekly for insert with check (org_id = current_org_id());
create policy activation_weekly_update on activation_org_weekly for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy activation_weekly_delete on activation_org_weekly for delete using (org_id = current_org_id());
create policy activation_weekly_owner_read on activation_org_weekly for select to webhook_owner using (true);
grant select, insert, update, delete on activation_org_weekly to webhook_app;

-- ============================================================================================
-- 3) activation_org_exclusions — internal/test/founder orgs kept out of every metric. Secured purely by
--    OWNERSHIP (like processed_stripe_events): NO row-level security and NO webhook_app grant, so a tenant
--    has zero access — it cannot even self-exclude to game the metric. The SECURITY DEFINER review fn (owner)
--    reads it via ownership; ops seeds it via the provider/owner connection.
-- ============================================================================================
create table activation_org_exclusions (
  org_id uuid primary key references orgs (id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

-- ============================================================================================
-- 4) rollup_activation_milestones() — per-tenant (SECURITY INVOKER, webhook_app RLS). Fills signed_up_at
--    (from orgs.created_at, for an org with no signup-stamp yet) and lowers first_capture/forward via LEAST
--    (set-once: a milestone only ever moves EARLIER; a late/replayed scan can never regress it). MIN scans
--    are index-served (events_org_recent_idx, delivery_attempts_org_ordered_idx). Idempotent.
-- ============================================================================================
create function rollup_activation_milestones() returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_org uuid := current_org_id();
  v_rows bigint;
begin
  insert into activation_org_milestones (org_id, signed_up_at, first_capture_at, first_forward_at, updated_at)
  select
    o.id,
    o.created_at,
    (select min(e.received_at) from events e where e.org_id = o.id),
    (select min(d.created_at) from delivery_attempts d where d.org_id = o.id and d.status = 'forwarded'),
    now()
  from orgs o
  where o.id = v_org
  on conflict (org_id) do update set
    -- LEAST ignores nulls, so an already-set milestone only lowers, never regresses; signed_up_at and the
    -- first_touch_* columns (stamped at signup) are deliberately NOT overwritten here.
    first_capture_at = least(activation_org_milestones.first_capture_at, excluded.first_capture_at),
    first_forward_at = least(activation_org_milestones.first_forward_at, excluded.first_forward_at),
    updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;
grant execute on function rollup_activation_milestones() to webhook_app;

-- ============================================================================================
-- 5) rollup_activation_weekly(p_week_start date) — per-tenant. Records whether THIS org captured and/or
--    forwarded within the ISO week starting `p_week_start` (Monday). OR-accumulates so re-runs across the
--    settle window only ever flip a flag true. No row is written for a week with no activity.
-- ============================================================================================
create function rollup_activation_weekly(p_week_start date) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_org uuid := current_org_id();
  v_week date := date_trunc('week', p_week_start::timestamptz)::date;
  v_start timestamptz := v_week::timestamptz;
  v_end timestamptz := (v_week + 7)::timestamptz;
  v_captured boolean;
  v_forwarded boolean;
  v_rows bigint;
begin
  v_captured := exists (
    select 1 from events e
     where e.org_id = v_org and e.received_at >= v_start and e.received_at < v_end
  );
  v_forwarded := exists (
    select 1 from delivery_attempts d
     where d.org_id = v_org and d.status = 'forwarded' and d.created_at >= v_start and d.created_at < v_end
  );
  if not v_captured and not v_forwarded then
    return 0; -- no activity this week for this org; nothing to record
  end if;
  insert into activation_org_weekly (org_id, iso_week, captured, forwarded, updated_at)
  values (v_org, v_week, v_captured, v_forwarded, now())
  on conflict (org_id, iso_week) do update set
    captured = activation_org_weekly.captured or excluded.captured,
    forwarded = activation_org_weekly.forwarded or excluded.forwarded,
    updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;
grant execute on function rollup_activation_weekly(date) to webhook_app;

-- ============================================================================================
-- 6) activation_weekly_review() — the founder's weekly review. SECURITY DEFINER (owner), search_path pinned
--    (anti-hijack), reads the three activation tables cross-org via the `to webhook_owner` policies above,
--    and returns AGGREGATES ONLY — never an org_id, never PII. Excludes activation_org_exclusions. One row
--    per ISO week combining the one-time funnel (signups/first_captures/first_forwards + TTFV, from
--    milestones) and the weekly-recurrence NSM (activated_orgs, from activation_org_weekly).
-- ============================================================================================
create function activation_weekly_review()
  returns table (
    iso_week date,
    signups bigint,
    first_captures bigint,
    first_forwards bigint,
    activated_orgs bigint,
    activation_rate numeric,
    ttfv_median_hours numeric,
    ttfv_p90_hours numeric
  )
  language sql
  stable
  security definer
  set search_path = public
  as $$
    with m as (
      select *
        from activation_org_milestones
       where org_id not in (select org_id from activation_org_exclusions)
    ),
    signups as (
      select date_trunc('week', signed_up_at)::date as wk, count(*) as n
        from m group by 1
    ),
    caps as (
      select date_trunc('week', first_capture_at)::date as wk, count(*) as n
        from m where first_capture_at is not null group by 1
    ),
    fwds as (
      select date_trunc('week', first_forward_at)::date as wk,
             count(*) as n,
             percentile_cont(0.5) within group (
               order by extract(epoch from (first_forward_at - signed_up_at)) / 3600.0) as ttfv_median,
             percentile_cont(0.9) within group (
               order by extract(epoch from (first_forward_at - signed_up_at)) / 3600.0) as ttfv_p90
        from m where first_forward_at is not null group by 1
    ),
    active as (
      select iso_week as wk, count(*) as n
        from activation_org_weekly
       where captured and forwarded
         and org_id not in (select org_id from activation_org_exclusions)
       group by 1
    ),
    weeks as (
      select wk from signups
      union select wk from caps
      union select wk from fwds
      union select wk from active
    )
    select
      w.wk as iso_week,
      coalesce(s.n, 0) as signups,
      coalesce(c.n, 0) as first_captures,
      coalesce(f.n, 0) as first_forwards,
      coalesce(a.n, 0) as activated_orgs,
      case when coalesce(s.n, 0) = 0 then 0
           else round(coalesce(f.n, 0)::numeric / s.n, 4) end as activation_rate,
      round(f.ttfv_median::numeric, 4) as ttfv_median_hours,
      round(f.ttfv_p90::numeric, 4) as ttfv_p90_hours
    from weeks w
    left join signups s on s.wk = w.wk
    left join caps c on c.wk = w.wk
    left join fwds f on f.wk = w.wk
    left join active a on a.wk = w.wk
    order by w.wk
  $$;
grant execute on function activation_weekly_review() to webhook_app;

-- migrate:down

drop function if exists activation_weekly_review();
drop function if exists rollup_activation_weekly(date);
drop function if exists rollup_activation_milestones();
drop table if exists activation_org_exclusions;
drop table if exists activation_org_weekly;
drop table if exists activation_org_milestones;
