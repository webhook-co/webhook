-- migrate:up

-- delivery_subscriptions (S3 Slice 3 PR2): the Tier-3 routing model that selects which captured events
-- auto-deliver to which destinations. A subscription is a (source endpoint -> destination) join selecting
-- on provider + event_types + require_verified (AND-combined; see packages/db/src/subscriptions.ts for the
-- pure matcher). The zero-config default — provider null, event_types '{*}', require_verified false — means
-- "deliver everything from this endpoint to this destination". One subscription per (org, source endpoint,
-- destination) pair; its selectors are editable (create upserts), and `enabled` pauses routing without
-- deleting. channels + filter are RESERVED for the future send-API / content filtering (NOT evaluated in v1).
--
-- Standard tenant-table shape (migration 0003 / 0024): org_id + RLS ENABLED + FORCE + per-command policies
-- on current_org_id() (deny-by-default), DML granted to webhook_app only. Ids are UUIDv7 (edge-generated, no
-- DB default). Composite FKs to endpoints(id, org_id) and replay_destinations(id, org_id) so a subscription
-- can never bind across orgs (defense-in-depth on RLS), both cascading so removing the endpoint or the
-- destination removes its routing. `unique (id, org_id)` is the target for a future child's composite
-- (subscription_id, org_id) FK (PR2c delivery_attempts).
create table delivery_subscriptions (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  -- the SOURCE endpoint whose captured events this subscription routes.
  source_endpoint_id uuid not null,
  -- the destination the matched events deliver to (the replay_destinations allowlist row).
  destination_id uuid not null,
  -- provider filter: null = match any provider; otherwise the event's provider must equal this.
  provider text,
  -- event_type patterns: exact (`charge.succeeded`), trailing glob (`charge.*`), or `*` (all). Default
  -- matches everything; a null (unextracted) event_type only matches `*`. Stored as a jsonb string array
  -- (the repo convention for string lists, e.g. api_keys.scopes) — matching is done in JS, not SQL.
  event_types jsonb not null default '["*"]'::jsonb,
  -- when true, only verified (signature-checked) events route through this subscription.
  require_verified boolean not null default false,
  -- RESERVED (future send-API channels). Not evaluated by the v1 matcher.
  channels jsonb not null default '[]'::jsonb,
  -- RESERVED (future content filtering over the payload). Not evaluated by the v1 matcher.
  filter jsonb,
  -- false pauses routing without deleting the subscription (delete removes it entirely).
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one subscription per (org, source endpoint, destination); create upserts its selectors.
  unique (org_id, source_endpoint_id, destination_id),
  -- composite-FK target for a future child (PR2c delivery_attempts.subscription_id).
  unique (id, org_id),
  foreign key (source_endpoint_id, org_id) references endpoints (id, org_id) on delete cascade,
  foreign key (destination_id, org_id) references replay_destinations (id, org_id) on delete cascade
);
-- the ingest resolver reads a source endpoint's ENABLED subscriptions (then filters in JS via the matcher).
create index delivery_subscriptions_source_idx
  on delivery_subscriptions (org_id, source_endpoint_id)
  where enabled;
alter table delivery_subscriptions enable row level security;
alter table delivery_subscriptions force row level security;
create policy delivery_subscriptions_select on delivery_subscriptions for select using (org_id = current_org_id());
create policy delivery_subscriptions_insert on delivery_subscriptions for insert with check (org_id = current_org_id());
create policy delivery_subscriptions_update on delivery_subscriptions for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy delivery_subscriptions_delete on delivery_subscriptions for delete using (org_id = current_org_id());
grant select, insert, update, delete on delivery_subscriptions to webhook_app;

-- migrate:down

drop table if exists delivery_subscriptions;
