-- migrate:up

-- S4.4d metering reconciliation oracle (money-correctness guard F6). The rollup (rollup_usage, run per-org
-- as webhook_app) freezes each finalized day's event_count into `usage`. If a rollup bug (F1–F3: a missed
-- tail, a bad bucket, a dedup miscount) froze a WRONG count, nothing catches it — the frozen count is then
-- the billing source of truth. F6 is an INDEPENDENT cross-check: recount the raw `events` rows per finalized
-- day from scratch, via a SEPARATE role + code path than the rollup, and alarm on any drift vs the frozen
-- `usage.event_count`. The independence is the point — a shared role/path would reproduce the same bug on
-- both sides and hide the drift.
--
-- webhook_meter_audit is that role: a NON-OWNER, NOSUPERUSER, NOBYPASSRLS cross-org READER, mirroring the
-- webhook_meter/webhook_reconciler pattern (role-targeted `FOR SELECT TO … USING(true)` policies + column
-- grants; no write anywhere). Deliberately DISTINCT from webhook_meter, which is column-scoped to the
-- enumeration keys and is specifically DENIED usage.event_count (0040/0042) — the reconciler must read the
-- frozen count to compare it, so it needs its own grant, and keeping it a separate role preserves the
-- enumeration role's least-privilege boundary. The login password is injected out of band (Neon), never a
-- literal here; created idempotently so local/CI (trust auth) and managed prod both work.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_meter_audit') then
    create role webhook_meter_audit login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_meter_audit;

-- Role-targeted SELECT policies (FOR SELECT TO webhook_meter_audit only) — the cross-org read gate. events
-- and usage are FORCE RLS, so even the owner is policed; this permissive policy is scoped to this role, so
-- webhook_app still sees only its own org via the existing per-org policies.
create policy events_meter_audit_select on events
  for select to webhook_meter_audit using (true);
create policy usage_meter_audit_select on usage
  for select to webhook_meter_audit using (true);

-- COLUMN grants (least privilege). events: ONLY (org_id, received_at) — enough to recount per org per UTC
-- day; NEVER a payload / header / dedup column (the reconciler counts rows, it must not read content). usage:
-- (org_id, window_start, event_count, finalized_at) — the frozen count + its finalization marker to compare.
grant select (org_id, received_at) on events to webhook_meter_audit;
grant select (org_id, window_start, event_count, finalized_at) on usage to webhook_meter_audit;

-- migrate:down

revoke select (org_id, window_start, event_count, finalized_at) on usage from webhook_meter_audit;
revoke select (org_id, received_at) on events from webhook_meter_audit;
drop policy if exists usage_meter_audit_select on usage;
drop policy if exists events_meter_audit_select on events;
-- Leave the role in place on down (other environments may share it); dropping a login role that owns nothing
-- is safe but unnecessary, and mirrors 0033's choice to keep the role.
