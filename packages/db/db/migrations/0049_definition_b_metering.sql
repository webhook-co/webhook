-- migrate:up

-- Definition B (founder 2026-07-09, ADR-0004 + internal research/unit-economics-2026-07-09.md):
--
--   A BILLED EVENT IS ONE INBOUND CAPTURE **OR** ONE OUTBOUND DELIVERY DISPATCH.
--
-- Why: the billable unit did not track the work. `usage` counted only rows in `events` (inbound
-- captures), while outbound delivery — which costs ~3.6x an ingest on Cloudflare — metered ZERO.
-- Destinations per endpoint are uncapped, so the cost of a single billed event was
-- `ingest + (destinations x attempts x cost)`: an unbounded multiplier the customer sets for free.
-- The old pricing "fixed" this by gating outbound delivery behind a paid tier, which was a workaround
-- for a metering bug (and was never implemented). Counting the delivery instead dissolves the gate:
-- cost per billed event becomes flat and bounded, so EVERY feature ships on EVERY plan, Free included.
--
-- This is NOT a second metering dimension. It is the same unit — an event — counted wherever the work
-- happens. The constitution's "single overage dimension = events, never per-step/per-feature" holds.
--
-- RETRIES ARE NEVER BILLED. A dispatch is one row in `delivery_attempts`: the enqueue inserts the row
-- with attempt = 1, and every retry UPDATES that same row in place (`set attempt = <next>`), so
-- `count(*)` counts dispatches, not attempts. Our retry schedule is our cost, and a receiver's downtime
-- is not the customer's fault — billing 8 attempts for one failed delivery is exactly the bill-shock
-- this product exists to prevent. (Do not "improve" this to `sum(attempt)`.)
--
-- Window key: `delivery_attempts.created_at` (when the dispatch was enqueued), matching `events`'
-- `received_at`. A dispatch that retries across midnight stays billed to the day it was created, which
-- keeps the rollup idempotent — re-running it recomputes the identical count.
--
-- NOT RETROACTIVE: the upsert's `where usage.finalized_at is null` guard (0040, money-guard F1) means
-- already-finalized days keep their capture-only counts. Definition B applies from the first unfinalized
-- window forward. No customer is retro-billed for deliveries we previously gave away.

-- Which basis produced this row. Existing rows were counted CAPTURE-ONLY and many are already finalized
-- (immutable, money-guard F1), so the F6 reconciliation oracle must recount them under the definition that
-- actually produced them — otherwise every historical day reports false drift the moment Definition B lands.
-- Rows written from here on count deliveries too.
alter table usage add column counts_deliveries boolean not null default false;
alter table usage alter column counts_deliveries set default true;

grant select (org_id, window_start, event_count, finalized_at, counts_deliveries) on usage to webhook_meter_audit;

create or replace function rollup_usage(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  -- SECURITY INVOKER + per-org tenant context: both legs below are policed by RLS, exactly as the
  -- events-only version was. `union all` (not `union`) — the two legs count different things and must
  -- never be deduplicated against each other. An org with ONLY deliveries in this window (e.g. a replay
  -- of an older event) still gets its usage row, because the outer group-by spans both legs.
  insert into usage (org_id, window_start, event_count, updated_at, counts_deliveries)
  select s.org_id, v_window, sum(s.n), now(), true
  from (
    select e.org_id, count(*)::bigint as n
    from events e
    where e.received_at >= v_window
      and e.received_at < v_window + interval '1 day'
    group by e.org_id

    union all

    -- One row per DISPATCH. Retries mutate the row, they do not insert a new one.
    select d.org_id, count(*)::bigint as n
    from delivery_attempts d
    where d.created_at >= v_window
      and d.created_at < v_window + interval '1 day'
    group by d.org_id
  ) s
  group by s.org_id
  on conflict (org_id, window_start)
  do update set event_count = excluded.event_count, updated_at = now(), counts_deliveries = true
    where usage.finalized_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

grant execute on function rollup_usage(timestamptz) to webhook_app;

-- The rollup's org enumeration runs as `webhook_meter` and must now also find orgs whose only recent
-- activity was an outbound DISPATCH (a replay of an older event captures nothing). Without this the org
-- is never enumerated, its window is never rolled, and those billed events are silently given away.
-- Column-scoped to exactly what the enumeration reads; no write; still NOBYPASSRLS.
grant select (org_id, created_at) on delivery_attempts to webhook_meter;

create policy delivery_attempts_meter_select on delivery_attempts
  for select to webhook_meter using (true);

-- The F6 reconciliation oracle recounts usage from scratch under `webhook_meter_audit`, on a different
-- code path and a different role, to catch a drifting rollup. Its recount must now span the same two
-- legs, so the role needs the same column-scoped, cross-org read on delivery_attempts that it already
-- has on events. SELECT of exactly two columns; no write anywhere; still NOBYPASSRLS.
grant select (org_id, created_at) on delivery_attempts to webhook_meter_audit;

-- delivery_attempts is FORCE RLS, so a role-targeted permissive policy is the cross-org read gate
-- (mirrors events_meter_audit_select / usage_meter_audit_select in 0046). Scoped `to webhook_meter_audit`
-- so webhook_app continues to see only its own org through the existing per-org policies.
create policy delivery_attempts_meter_audit_select on delivery_attempts
  for select to webhook_meter_audit using (true);

-- migrate:down

drop policy if exists delivery_attempts_meter_audit_select on delivery_attempts;
drop policy if exists delivery_attempts_meter_select on delivery_attempts;
revoke select (org_id, created_at) on delivery_attempts from webhook_meter_audit;
revoke select (org_id, created_at) on delivery_attempts from webhook_meter;
alter table usage drop column if exists counts_deliveries;

-- Restore the capture-only rollup (0040's definition).
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
