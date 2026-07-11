-- migrate:up

-- Metering truth (S1). Definition B (0049) bills one inbound CAPTURE **or** one outbound delivery
-- DISPATCH, and counts a dispatch as `count(*)` over `delivery_attempts`. Two kinds of row in that table
-- are not a dispatch we performed, and were being billed anyway:
--
--   1. A LOCALHOST TUNNEL FORWARD (`wbhk listen --forward`, `wbhk replay`). The CLI POSTs to the user's own
--      machine — our Worker makes NO outbound request. The row exists only as the durable audit +
--      idempotency record of a forward that already happened elsewhere (packages/db/src/replay.ts). It is
--      not "a delivery to a destination" (the pricing page's words; `destination_id` is null), and the two
--      calls it does cost us — events.get + events.getPayload — are already free. This billed the wedge
--      command's every webhook TWICE.
--   2. A delivery the SSRF guard REFUSED to send (`blocked`). The bytes never left our network. Billing it
--      is unbounded bill-shock on a misconfigured destination URL — and `blocked` deliberately does not
--      trip auto-disable (0033: a DNS blip must not disable a healthy destination), so nothing bounds it.
--
-- Retries are still billed exactly once: a retry UPDATEs its row, it never inserts another (0049).
--
-- The discriminator is an EXPLICIT column, never inferred from `destination_id is null`. Nothing enforces
-- that invariant, so a writer that forgot it would become silent unbilled REVENUE — whereas `default true`
-- means a forgetful writer fails toward billing real work. Fail-safe points at the meter, not away from it.
alter table delivery_attempts add column billable boolean not null default true;

-- Which basis produced this usage row — the `counts_deliveries` precedent (0049), for the same reason.
-- Days frozen before this migration counted EVERY dispatch and are immutable (money-guard F1), so the F6
-- reconciliation oracle must recount each day under the definition that actually produced it. Without this,
-- every historical day reports false drift the moment the billable split lands — which trains us to ignore
-- the one alarm guarding live money.
alter table usage add column counts_only_billable boolean not null default false;
alter table usage alter column counts_only_billable set default true;

grant select (org_id, window_start, event_count, finalized_at, counts_deliveries, counts_only_billable)
  on usage to webhook_meter_audit;
grant select (org_id, created_at, billable) on delivery_attempts to webhook_meter_audit;

-- webhook_meter's grant is deliberately NOT widened. It only ENUMERATES orgs with recent activity; the
-- count itself is rollup_usage's job. Enumerating an org whose only activity was unbillable is harmless —
-- the rollup then simply finds nothing to write for it.

-- ── The trigger: what keeps the F6 oracle a pure function ─────────────────────────────────────────────────
-- F6 recounts `delivery_attempts` from scratch and compares to the FROZEN `usage.event_count`. That recount
-- is only sound if it reads state that CANNOT change after the day was frozen. `count(*)` was trivially
-- sound (a row's existence is immutable); `count(*) filter (where billable)` is not, unless `billable` is.
--
-- So make it immutable in the only two directions that matter:
--
--   (a) It never rises back to true. Un-billing is a one-way decision; a bug that re-billed a forgiven
--       dispatch would be a silent overcharge, and there is no legitimate reason to raise it.
--   (b) It never falls to false once the row's OWN day has been finalized in `usage`. That day was already
--       billed and is immutable (F1). A dispatch still `queued` when its day froze and only blocked
--       afterwards would otherwise make the recount undershoot a CORRECT frozen count — forever. An
--       unfixable drift alarm on the one signal guarding live money is worse than one billed dispatch.
--       (The delivery retry schedule exhausts in ~28h and USAGE_SETTLE_DAYS is 2, so this is already
--       unreachable in the happy path; this makes it unreachable, full stop, for any future schedule.)
--
-- Not an exception on (b): the caller is finalizing a delivery, and raising here would roll that back and
-- re-drive the delivery forever. Silently keeping the (already-billed, already-frozen) decision is correct.
create or replace function guard_billable_immutable() returns trigger
  language plpgsql
  security invoker
  as $$
begin
  if new.billable is not distinct from old.billable then
    return new; -- the overwhelmingly common path (every retry / delivered / dead write): no usage read
  end if;
  if new.billable then
    raise exception 'delivery_attempts.billable may never be raised to true (row %)', old.id
      using errcode = 'check_violation';
  end if;
  -- The row's own UTC day, expressed as a containment test against usage's (org_id, window_start) PK —
  -- no date_trunc, so it cannot drift with the session TimeZone the way a truncation would.
  if exists (
    select 1 from usage u
     where u.org_id = old.org_id
       and u.finalized_at is not null
       and old.created_at >= u.window_start
       and old.created_at < u.window_start + interval '1 day'
  ) then
    new.billable := old.billable; -- frozen day: already billed, stays billed
  end if;
  return new;
end
$$;

create trigger delivery_attempts_billable_immutable
  before update on delivery_attempts
  for each row execute function guard_billable_immutable();

-- ── The rollup leg ───────────────────────────────────────────────────────────────────────────────────────
-- Identical to 0049 except the dispatch leg now counts only billable rows, and the row records that basis.
create or replace function rollup_usage(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into usage (org_id, window_start, event_count, updated_at, counts_deliveries, counts_only_billable)
  select s.org_id, v_window, sum(s.n), now(), true, true
  from (
    select e.org_id, count(*)::bigint as n
    from events e
    where e.received_at >= v_window
      and e.received_at < v_window + interval '1 day'
    group by e.org_id

    union all

    -- One row per BILLABLE DISPATCH. Retries mutate the row, they do not insert a new one.
    select d.org_id, count(*)::bigint as n
    from delivery_attempts d
    where d.created_at >= v_window
      and d.created_at < v_window + interval '1 day'
      and d.billable
    group by d.org_id
  ) s
  group by s.org_id
  on conflict (org_id, window_start)
  do update set event_count = excluded.event_count, updated_at = now(),
                counts_deliveries = true, counts_only_billable = true
    where usage.finalized_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

grant execute on function rollup_usage(timestamptz) to webhook_app;

-- migrate:down

drop trigger if exists delivery_attempts_billable_immutable on delivery_attempts;
drop function if exists guard_billable_immutable();

-- Revoke ONLY the column this migration added. Postgres column privileges are not reference-counted, so
-- naming (org_id, created_at) here would also strip 0049's still-needed grant and break the F6 reconciler
-- on a down-then-reconcile. `usage` needs no explicit revoke: dropping counts_only_billable removes it from
-- the grant, and the surviving columns were already granted by 0046/0049.
revoke select (billable) on delivery_attempts from webhook_meter_audit;
alter table usage drop column if exists counts_only_billable;
alter table delivery_attempts drop column if exists billable;

-- Restore 0049's rollup (every dispatch billed).
create or replace function rollup_usage(p_window_start timestamptz) returns bigint
  language plpgsql
  security invoker
  as $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into usage (org_id, window_start, event_count, updated_at, counts_deliveries)
  select s.org_id, v_window, sum(s.n), now(), true
  from (
    select e.org_id, count(*)::bigint as n
    from events e
    where e.received_at >= v_window
      and e.received_at < v_window + interval '1 day'
    group by e.org_id
    union all
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
