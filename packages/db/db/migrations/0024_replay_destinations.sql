-- migrate:up

-- replay_destinations (ADR-0081): an ORG-LEVEL allowlist of HTTPS URLs that events.replay may deliver
-- to. This is a SAFETY/trust control — the closed replay TargetSchema gains a `{kind:"destination",
-- destinationId}` arm that references a row here, so a remote replay can never carry a free-form URL
-- (SSRF + confused-deputy containment, ADR-0005). It is DISTINCT from S3's per-endpoint outbound
-- routing + the per-endpoint signing_keys table; do not grow signing/routing columns here.
--
-- Standard tenant-table shape (migration 0003): org_id + RLS ENABLED + FORCE + per-command policies on
-- current_org_id() (deny-by-default), DML granted to webhook_app only. Ids are UUIDv7 (edge-generated,
-- no DB default) for index locality. deleted_at is the SINGLE soft-delete marker (migration 0021
-- convention): null = live (active), set = removed (revoked) + retained for audit and excluded from
-- reads + the live-url guard. The API renders the lifecycle as a status WORD (active|revoked) DERIVED
-- from deleted_at (db toRecord) — a timestamp, never a bool — so there is exactly one source of truth
-- for "is this live" (no status/deleted_at drift, unlike a redundant status column).
create table replay_destinations (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  -- the canonical, structurally-validated URL (https, lowercased host, default port stripped). The
  -- authoritative private-range/SSRF check runs at DELIVERY time (connect-time guard, ADR-0081); the
  -- create-time check is structural + an advisory resolve, so this column is never a "safe to skip the
  -- guard" flag.
  url text not null,
  label text,
  created_at timestamptz not null default now(),
  -- last time the URL passed a structural/resolve check (advisory; updated on create + future re-checks).
  last_validated_at timestamptz,
  -- soft-delete: a removed destination is retained (audit) but excluded from reads + the live-url guard.
  deleted_at timestamptz,
  -- target for a future child's composite (destination_id, org_id) FK (1b delivery_attempts), so a
  -- delivery row can never reference a destination owned by a different org (defense-in-depth on RLS).
  unique (id, org_id)
);
-- One live allowlist entry per (org, canonical url). A soft-deleted row drops out so the same URL can be
-- re-added later; a partial index keeps the constraint scoped to live rows.
create unique index replay_destinations_live_url_idx
  on replay_destinations (org_id, url)
  where deleted_at is null;
alter table replay_destinations enable row level security;
alter table replay_destinations force row level security;
create policy replay_destinations_select on replay_destinations for select using (org_id = current_org_id());
create policy replay_destinations_insert on replay_destinations for insert with check (org_id = current_org_id());
create policy replay_destinations_update on replay_destinations for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy replay_destinations_delete on replay_destinations for delete using (org_id = current_org_id());
grant select, insert, update, delete on replay_destinations to webhook_app;

-- migrate:down

drop table if exists replay_destinations;
