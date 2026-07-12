-- migrate:up

-- delivery_stats — a daily per-org rollup of outbound-delivery OUTCOMES, so the /dashboard overview reads
-- O(days), not O(deliveries). A `group by status` over millions of delivery_attempts on every page load is
-- what dies at scale; this pre-aggregates it once an hour.
--
-- NOT billing (unlike `usage`), so it needs no finalize/immutability freeze — it is a display cache. Recent
-- days refine as deliveries settle (a delivery can retry for ~28h), which the hourly re-roll handles via the
-- upsert. The dashboard states "may be delayed by up to an hour", matching this cadence.
--
-- Counts only the meaningful TERMINAL outcomes: delivered (success), dead (retries exhausted), blocked (an
-- SSRF refusal). queued/pending are in-flight (not yet an outcome) and excluded; a still-pending delivery is
-- simply counted once it settles on a later re-roll. p95 latency is over DELIVERED rows' duration_ms only —
-- the latency a healthy delivery took — and is null until measured deliveries accrue (duration_ms is
-- forward-only, migration 0062).
create table delivery_stats (
  org_id uuid not null references orgs (id) on delete cascade,
  window_start timestamptz not null,
  delivered_count bigint not null default 0,
  dead_count bigint not null default 0,
  blocked_count bigint not null default 0,
  -- p95 of duration_ms across DELIVERED deliveries that day; null = no measured deliveries (tile shows "—").
  p95_duration_ms integer,
  updated_at timestamptz not null default now(),
  primary key (org_id, window_start)
);
alter table delivery_stats enable row level security;
alter table delivery_stats force row level security;
create policy delivery_stats_select on delivery_stats for select using (org_id = current_org_id());
create policy delivery_stats_insert on delivery_stats for insert with check (org_id = current_org_id());
create policy delivery_stats_update on delivery_stats for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy delivery_stats_delete on delivery_stats for delete using (org_id = current_org_id());
grant select, insert, update, delete on delivery_stats to webhook_app;

-- Roll up one daily window for the CURRENT org (SECURITY INVOKER + RLS — the delivery_attempts SELECT and the
-- delivery_stats upsert are both org-policed, no cross-org aggregation, no BYPASSRLS). The driver iterates
-- orgs (enumerated cross-org via webhook_meter) and calls this inside each tenant's withTenant context.
-- Idempotent: re-running recomputes the same counts (upsert), safe to retry as deliveries settle.
create function rollup_delivery_stats(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into delivery_stats
    (org_id, window_start, delivered_count, dead_count, blocked_count, p95_duration_ms, updated_at)
  select
    d.org_id,
    v_window,
    count(*) filter (where d.status = 'delivered'),
    count(*) filter (where d.status = 'dead'),
    count(*) filter (where d.status = 'blocked'),
    -- FILTER on the ordered-set aggregate: p95 over only the delivered rows that carry a measured duration.
    -- null when there are none — never a fabricated 0.
    (percentile_cont(0.95) within group (order by d.duration_ms)
       filter (where d.status = 'delivered' and d.duration_ms is not null))::int,
    now()
  from delivery_attempts d
  where d.created_at >= v_window
    and d.created_at < v_window + interval '1 day'
  group by d.org_id
  on conflict (org_id, window_start) do update set
    delivered_count = excluded.delivered_count,
    dead_count = excluded.dead_count,
    blocked_count = excluded.blocked_count,
    p95_duration_ms = excluded.p95_duration_ms,
    updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

grant execute on function rollup_delivery_stats(timestamptz) to webhook_app;

-- migrate:down

drop function if exists rollup_delivery_stats(timestamptz);
drop table if exists delivery_stats;
