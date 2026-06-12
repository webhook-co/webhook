-- migrate:up

-- Events-derived usage rollup (H3, plan §metering-abuse). Metering is DERIVED from
-- events — there is deliberately NO counter inside ingest_event, so the single-
-- statement hot path / H5 stay intact and there is no per-event write contention.
-- Exactly-once falls out of the unique (endpoint_id, dedup_key) constraint: a retry
-- never creates a second event row, so it can never be counted twice.
--
-- SECURITY INVOKER + RLS: the rollup runs per-org with the tenant context set, so the
-- events SELECT and the usage upsert are both policed (no cross-org aggregation, no
-- BYPASSRLS). The scheduler iterates orgs (or runs in each tenant's context); this
-- function rolls up exactly the current org's events for one daily window. Idempotent:
-- re-running recomputes the same count (upsert), so it's safe to retry.

create function rollup_usage(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  -- Align the window to a day boundary so an unaligned/overlapping key can't
  -- double-count across windows (metering integrity).
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

grant execute on function rollup_usage(timestamptz) to webhook_app;

-- migrate:down

drop function if exists rollup_usage(timestamptz);
