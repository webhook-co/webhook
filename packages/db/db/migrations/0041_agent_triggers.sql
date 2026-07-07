-- migrate:up

-- NOTE ON THE NUMBER (0041, not 0040): migration 0040 is RESERVED by the concurrent S4 billing/metering
-- lane, whose 0040 is already APPLIED TO PROD (ahead of its PR merge). Reusing 0040 here would collide on
-- the schema_migrations version — dbmate would treat this migration as already-applied on prod and SILENTLY
-- skip it, leaving agent_triggers uncreated while the api/mcp workers read it → 500s. The gap is deliberate
-- and correct; do NOT renumber to 0040. dbmate applies by version and tolerates the gap.

-- agent_triggers (S5): an agent's subscription to receive webhook→agent TRIGGERS over MCP. A trigger
-- registration is a thin (org, endpoint) binding that an authenticated principal creates to be woken
-- (via the triggers.wait long-poll tool) when the endpoint captures a new event. It is deliberately a
-- READ-consumption construct, NOT an egress route: it never sends data to a third party, so — unlike
-- delivery_subscriptions (0029), which are mcp-EXEMPT for confused-deputy reasons — triggers.* are safe
-- to bind on MCP. The row carries no secret and no payload; consumption reads the org's own events
-- through the same RLS-scoped tail the caller could already read (events:read).
--
-- Tenant-table conventions (mirror 0029_delivery_subscriptions.sql): id is an edge-minted UUIDv7 (no DB
-- default); org_id cascades from orgs; a composite FK (endpoint_id, org_id) -> endpoints(id, org_id)
-- makes a cross-org binding structurally impossible (defense-in-depth beyond RLS); unique (id, org_id)
-- is the composite-FK target for any future child table. FORCE row level security + four per-command
-- policies on current_org_id() (deny-by-default); DML granted to webhook_app ONLY. There are deliberately
-- NO role-targeted `to webhook_<role> using(true)` policies — no cross-org reader touches this table.
create table agent_triggers (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  endpoint_id uuid not null,
  name text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, org_id),
  foreign key (endpoint_id, org_id) references endpoints (id, org_id) on delete cascade
);

-- Lists an org's ACTIVE triggers for an endpoint (triggers.list default view); partial on the live set.
create index agent_triggers_endpoint_idx
  on agent_triggers (org_id, endpoint_id)
  where revoked_at is null;

alter table agent_triggers enable row level security;
alter table agent_triggers force row level security;
create policy agent_triggers_select on agent_triggers for select using (org_id = current_org_id());
create policy agent_triggers_insert on agent_triggers for insert with check (org_id = current_org_id());
create policy agent_triggers_update on agent_triggers for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy agent_triggers_delete on agent_triggers for delete using (org_id = current_org_id());
grant select, insert, update, delete on agent_triggers to webhook_app;

-- migrate:down

drop table if exists agent_triggers;
