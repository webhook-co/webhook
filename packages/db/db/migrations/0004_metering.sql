-- migrate:up

-- Metering + soft-cap (H3, plan §metering-abuse). Single-dimension (events only).
-- NO prices/tiers/cost figures live in this repo (constitution). Usage is DERIVED
-- from events via an async rollup (exactly-once thanks to the unique
-- (endpoint_id, dedup_key) constraint) — there is deliberately NO counter inside
-- ingest_event, so the single-statement hot path / H5 stay intact. Soft-cap pause is
-- enforced on ingest by a CACHED org cap/paused signal (read on KV endpoint
-- resolution), never a synchronous count — so the ingest role needs no read here.

-- usage: per-org rollup window. window_start is the truncated window key; the rollup
-- upserts event_count. Exactly-once is guaranteed upstream by the dedup constraint.
create table usage (
  org_id uuid not null references orgs (id) on delete cascade,
  window_start timestamptz not null,
  event_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (org_id, window_start)
);
alter table usage enable row level security;
alter table usage force row level security;
create policy usage_select on usage for select using (org_id = current_org_id());
create policy usage_insert on usage for insert with check (org_id = current_org_id());
create policy usage_update on usage for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy usage_delete on usage for delete using (org_id = current_org_id());
grant select, insert, update, delete on usage to webhook_app;

-- org_limits: the numeric event cap + the pause policy. 'pause' = soft-cap pauses
-- ingest at the cap (the default — pause rather than bill-shock); 'allow' = keep
-- accepting (overage handled by a later, separate billing system). No prices here.
create table org_limits (
  org_id uuid primary key references orgs (id) on delete cascade,
  event_cap bigint,
  pause_policy text not null default 'pause' check (pause_policy in ('pause', 'allow')),
  updated_at timestamptz not null default now()
);
alter table org_limits enable row level security;
alter table org_limits force row level security;
create policy org_limits_select on org_limits for select using (org_id = current_org_id());
create policy org_limits_insert on org_limits for insert with check (org_id = current_org_id());
create policy org_limits_update on org_limits for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy org_limits_delete on org_limits for delete using (org_id = current_org_id());
grant select, insert, update, delete on org_limits to webhook_app;

-- ingest_paused: the durable source of truth for the cached pause signal. The ingest
-- path reads the CACHE (KV), not this table; the metering/soft-cap job writes here
-- and refreshes the cache. reason is an operator/system note, never PII.
create table ingest_paused (
  org_id uuid primary key references orgs (id) on delete cascade,
  paused boolean not null default false,
  reason text,
  since timestamptz,
  updated_at timestamptz not null default now()
);
alter table ingest_paused enable row level security;
alter table ingest_paused force row level security;
create policy ingest_paused_select on ingest_paused for select using (org_id = current_org_id());
create policy ingest_paused_insert on ingest_paused for insert with check (org_id = current_org_id());
create policy ingest_paused_update on ingest_paused for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy ingest_paused_delete on ingest_paused for delete using (org_id = current_org_id());
grant select, insert, update, delete on ingest_paused to webhook_app;

-- migrate:down

drop table if exists ingest_paused;
drop table if exists org_limits;
drop table if exists usage;
