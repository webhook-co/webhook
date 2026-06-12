-- migrate:up

-- Domain (tenant-owned) tables, indexes, and RLS. Every tenant table:
--   * carries org_id (orgs carries id) from creation,
--   * has RLS ENABLED + FORCE ROW LEVEL SECURITY (owner is policed too),
--   * has per-command policies gating on current_org_id() (deny-by-default: an
--     unset context -> NULL -> zero rows),
--   * grants DML to webhook_app only (webhook_ingest gets INSERT on events only).
-- Plan §0.1/§0.2, ADR-0012. Ids are UUIDv7, edge-generated (no DB default) for index
-- locality + a stable cursor tiebreaker (§0.10).

-- Tenant context for RLS. STABLE, SECURITY INVOKER (the default). nullif() turns an
-- empty GUC into NULL so an unset/blank context denies rather than erroring on cast.
create function current_org_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.current_org', true), '')::uuid $$;
comment on function current_org_id() is
  'Current tenant for RLS policies. NULL when app.current_org is unset/blank -> deny-by-default.';

-- orgs ---------------------------------------------------------------------------
create table orgs (
  id uuid primary key,
  slug citext not null unique,
  name text not null,
  region text not null default 'us',
  created_at timestamptz not null default now()
);
alter table orgs enable row level security;
alter table orgs force row level security;
create policy orgs_select on orgs for select using (id = current_org_id());
create policy orgs_insert on orgs for insert with check (id = current_org_id());
create policy orgs_update on orgs for update using (id = current_org_id()) with check (id = current_org_id());
create policy orgs_delete on orgs for delete using (id = current_org_id());
grant select, insert, update, delete on orgs to webhook_app;

-- memberships --------------------------------------------------------------------
create table memberships (
  org_id uuid not null references orgs (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_select on memberships for select using (org_id = current_org_id());
create policy memberships_insert on memberships for insert with check (org_id = current_org_id());
create policy memberships_update on memberships for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy memberships_delete on memberships for delete using (org_id = current_org_id());
grant select, insert, update, delete on memberships to webhook_app;

-- endpoints ----------------------------------------------------------------------
-- ingest_token_hash is the sha256 of the CSPRNG path token (H4) — the plaintext
-- token is shown once at creation and NEVER stored. Lookups are by hash.
create table endpoints (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  ingest_token_hash bytea not null unique,
  name text not null,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  -- Target for the children's composite (id, org_id) FKs so a child row can never
  -- reference an endpoint owned by a different org (defense-in-depth on top of RLS).
  unique (id, org_id)
);
alter table endpoints enable row level security;
alter table endpoints force row level security;
create policy endpoints_select on endpoints for select using (org_id = current_org_id());
create policy endpoints_insert on endpoints for insert with check (org_id = current_org_id());
create policy endpoints_update on endpoints for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy endpoints_delete on endpoints for delete using (org_id = current_org_id());
grant select, insert, update, delete on endpoints to webhook_app;

-- signing_keys (outbound, envelope-encrypted — §0.6) -----------------------------
create table signing_keys (
  id uuid primary key,
  endpoint_id uuid not null,
  org_id uuid not null references orgs (id) on delete cascade,
  secret_ciphertext bytea not null,
  wrapped_dek bytea not null,
  kek_ref text not null,
  enc_nonce bytea not null,
  enc_context jsonb not null default '{}'::jsonb,
  envelope_version smallint not null,
  status text not null check (status in ('active', 'retiring', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  foreign key (endpoint_id, org_id) references endpoints (id, org_id) on delete cascade
);
alter table signing_keys enable row level security;
alter table signing_keys force row level security;
create policy signing_keys_select on signing_keys for select using (org_id = current_org_id());
create policy signing_keys_insert on signing_keys for insert with check (org_id = current_org_id());
create policy signing_keys_update on signing_keys for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy signing_keys_delete on signing_keys for delete using (org_id = current_org_id());
grant select, insert, update, delete on signing_keys to webhook_app;

-- provider_secrets (inbound provider secrets, envelope-encrypted — §0.5/§0.6) -----
create table provider_secrets (
  id uuid primary key,
  endpoint_id uuid not null,
  org_id uuid not null references orgs (id) on delete cascade,
  provider text not null,
  label text,
  secret_ciphertext bytea not null,
  wrapped_dek bytea not null,
  kek_ref text not null,
  enc_nonce bytea not null,
  enc_context jsonb not null default '{}'::jsonb,
  envelope_version smallint not null,
  status text not null check (status in ('active', 'retiring', 'revoked')),
  created_at timestamptz not null default now(),
  foreign key (endpoint_id, org_id) references endpoints (id, org_id) on delete cascade
);
alter table provider_secrets enable row level security;
alter table provider_secrets force row level security;
create policy provider_secrets_select on provider_secrets for select using (org_id = current_org_id());
create policy provider_secrets_insert on provider_secrets for insert with check (org_id = current_org_id());
create policy provider_secrets_update on provider_secrets for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy provider_secrets_delete on provider_secrets for delete using (org_id = current_org_id());
grant select, insert, update, delete on provider_secrets to webhook_app;

-- events (received metadata; bodies live in R2 — §0.1) ---------------------------
-- headers + verification stored UNSCRUBBED (RLS + encryption + retention protect
-- them, not redaction — scrubbing would defeat the inspection wedge). received_at is
-- server-stamped by a trigger (H5 watermark invariant), never client-supplied.
create table events (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  endpoint_id uuid not null,
  received_at timestamptz not null default now(),
  payload_r2_key text not null,
  payload_r2_offset bigint,
  payload_bytes bigint not null,
  content_type text,
  content_hash bytea,
  headers jsonb not null default '[]'::jsonb,
  dedup_key text not null,
  dedup_strategy text not null,
  provider text,
  provider_event_id text,
  dedup_bucket bigint,
  external_id text,
  verified boolean not null default false,
  verification jsonb,
  created_at timestamptz not null default now(),
  unique (endpoint_id, dedup_key),
  -- the endpoint must belong to the same org as the event (defense-in-depth on RLS)
  foreign key (endpoint_id, org_id) references endpoints (id, org_id) on delete cascade,
  -- target for delivery_attempts' composite (event_id, org_id) FK
  unique (id, org_id)
);

-- H5: received_at is ALWAYS server time, on every insert path (ingest_event and any
-- app write). A trigger is the single source of truth so no caller can backdate a
-- row past the tunnel watermark.
create function events_stamp_received_at() returns trigger
  language plpgsql
  as $$
begin
  new.received_at := now();
  return new;
end
$$;
create trigger events_received_at_biu before insert on events
  for each row execute function events_stamp_received_at();

-- §0.1 indexes that matter for the hot path and the tunnel.
create index events_tunnel_idx on events (endpoint_id, received_at, id);
create index events_provider_idx on events (endpoint_id, provider, received_at desc);
create index events_org_recent_idx on events (org_id, received_at desc);

alter table events enable row level security;
alter table events force row level security;
create policy events_select on events for select using (org_id = current_org_id());
create policy events_insert on events for insert with check (org_id = current_org_id());
create policy events_update on events for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy events_delete on events for delete using (org_id = current_org_id());
-- webhook_app: full DML. webhook_ingest: INSERT + SELECT on events only (no
-- UPDATE/DELETE). SELECT is required because the dedup gate uses INSERT ... ON
-- CONFLICT (endpoint_id, dedup_key) DO NOTHING, and Postgres requires SELECT on the
-- arbiter for ON CONFLICT (a bare INSERT with a plpgsql unique_violation handler
-- would avoid SELECT but adds a per-insert subtransaction to the hot path, which §0.2
-- is explicitly performance-sensitive about). The role stays non-owner + RLS-enforced
-- + scoped to events alone, so a leaked ingest credential still only ever sees its
-- own org's rows (org context is server-derived per request).
grant select, insert, update, delete on events to webhook_app;
grant select, insert on events to webhook_ingest;

-- delivery_attempts (replay/forward attempts + idempotency store — §0.1, H6) ------
create table delivery_attempts (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  event_id uuid not null,
  target text not null,
  idempotency_key text,
  status text not null,
  status_code integer,
  attempt integer not null default 1,
  error text,
  created_at timestamptz not null default now(),
  foreign key (event_id, org_id) references events (id, org_id) on delete cascade
);
-- H6: persisted replay idempotency — (org_id, idempotency_key) unique when present.
create unique index delivery_attempts_idempotency_idx
  on delivery_attempts (org_id, idempotency_key)
  where idempotency_key is not null;
create index delivery_attempts_event_idx on delivery_attempts (event_id);
alter table delivery_attempts enable row level security;
alter table delivery_attempts force row level security;
create policy delivery_attempts_select on delivery_attempts for select using (org_id = current_org_id());
create policy delivery_attempts_insert on delivery_attempts for insert with check (org_id = current_org_id());
create policy delivery_attempts_update on delivery_attempts for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy delivery_attempts_delete on delivery_attempts for delete using (org_id = current_org_id());
grant select, insert, update, delete on delivery_attempts to webhook_app;

-- migrate:down

drop table if exists delivery_attempts;
drop trigger if exists events_received_at_biu on events;
drop function if exists events_stamp_received_at();
drop table if exists events;
drop table if exists provider_secrets;
drop table if exists signing_keys;
drop table if exists endpoints;
drop table if exists memberships;
drop table if exists orgs;
drop function if exists current_org_id();
