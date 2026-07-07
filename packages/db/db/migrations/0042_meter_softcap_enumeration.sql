-- migrate:up

-- S4.3 soft-cap enforcement. The cap-producer (runs in the metering cron after the rollup)
-- enumerates orgs that might need a pause/resume transition: those with usage this period, an
-- active pause, or an explicit org_limits row. It then processes each PER-ORG under webhook_app
-- RLS (reads period usage + limits + pause, writes ingest_paused). Only the cross-org
-- ENUMERATION needs new grants — extend webhook_meter (SELECT-only, migration 0040) with the two
-- control-plane keys it must scan. No write is granted (the producer's writes are webhook_app's).

-- Role-targeted SELECT policies (FOR SELECT TO webhook_meter only). org_limits: the cap + policy
-- (a per-org number + behavior — no prices). ingest_paused: the current pause flag, so a resume
-- transition can be found for an org that stopped sending (no usage row this period).
create policy org_limits_meter_select on org_limits
  for select to webhook_meter using (true);
create policy ingest_paused_meter_select on ingest_paused
  for select to webhook_meter using (true);

-- COLUMN grants (least privilege): only the enumeration keys, never the reason note.
grant select (org_id, event_cap, pause_policy) on org_limits to webhook_meter;
grant select (org_id, paused) on ingest_paused to webhook_meter;

-- migrate:down

revoke select (org_id, paused) on ingest_paused from webhook_meter;
revoke select (org_id, event_cap, pause_policy) on org_limits from webhook_meter;
drop policy if exists ingest_paused_meter_select on ingest_paused;
drop policy if exists org_limits_meter_select on org_limits;
