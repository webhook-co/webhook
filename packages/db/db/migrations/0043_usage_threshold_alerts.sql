-- migrate:up

-- usage_alerts: the per-(org, period, threshold) dedup ledger for usage-threshold notifications (S4.3b).
-- The metering cap producer runs HOURLY; without this ledger it would re-emit the "you've hit 80%" email
-- every tick. A row here records that the org's threshold-% alert for THIS billing period has already been
-- enqueued — the producer inserts ON CONFLICT DO NOTHING and only emits the notification when it wins the
-- insert (first crossing this period). A new period has a new period_start → new rows → the org is alerted
-- again next period. threshold is the percent-of-cap (e.g. 80, 100). RLS-scoped like usage/org_limits; the
-- producer writes it as webhook_app under withTenant, so INSERT/SELECT is all it needs (append-only in
-- practice — never updated or deleted on the hot path; old-period rows are harmless and prune later).
create table usage_alerts (
  org_id uuid not null references orgs (id) on delete cascade,
  period_start timestamptz not null,
  threshold smallint not null,
  alerted_at timestamptz not null default now(),
  primary key (org_id, period_start, threshold)
);
alter table usage_alerts enable row level security;
alter table usage_alerts force row level security;
create policy usage_alerts_select on usage_alerts for select using (org_id = current_org_id());
create policy usage_alerts_insert on usage_alerts for insert with check (org_id = current_org_id());
grant select, insert on usage_alerts to webhook_app;

-- migrate:down

drop table usage_alerts;
