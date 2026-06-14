-- p99 ingest benchmark setup. Run ONCE on the throwaway bench Neon branch AFTER the
-- migrations — NEVER a production migration. Provides variant A's RLS-off floor table and the
-- seeded org + endpoint all four variants insert against.
--
-- events_bench is a faithful copy of `events` (same columns, the received_at trigger, the same
-- indexes, the unique(endpoint_id, dedup_key) ON CONFLICT arbiter) EXCEPT it has NO row-level
-- security — so the A-vs-B delta isolates exactly the RLS + function overhead, nothing else.

create table if not exists events_bench (
  id uuid primary key,
  org_id uuid not null,
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
  unique (endpoint_id, dedup_key)
);

-- Same server-time received_at trigger as events, so A does the identical per-insert work.
create trigger events_bench_received_at_biu before insert on events_bench
  for each row execute function events_stamp_received_at();

-- Mirror the hot-path indexes so A's insert cost includes the same index maintenance as B/C/D.
create index if not exists events_bench_tunnel_idx on events_bench (endpoint_id, received_at, id);
create index if not exists events_bench_provider_idx on events_bench (endpoint_id, provider, received_at desc);
create index if not exists events_bench_org_recent_idx on events_bench (org_id, received_at desc);

-- The benchmark connects as webhook_ingest (non-owner, RLS-enforced on `events`). It needs
-- INSERT+SELECT on the RLS-off floor table too (SELECT for ON CONFLICT's arbiter).
grant insert, select on events_bench to webhook_ingest;

-- Seed the bench org + endpoint under that org's RLS context (orgs/endpoints are FORCE RLS, so even
-- the owner needs app.current_org set to satisfy the with-check policies).
select set_config('app.current_org', 'be000000-0000-4000-8000-000000000001', false);

insert into orgs (id, slug, name)
  values ('be000000-0000-4000-8000-000000000001', 'bench', 'Ingest Bench Org')
  on conflict (id) do nothing;

insert into endpoints (id, org_id, ingest_token_hash, name)
  values ('be000000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-000000000001',
          decode('00000000000000000000000000000000000000000000000000000000000000be', 'hex'), 'bench-endpoint')
  on conflict (id) do nothing;

-- Clear the session GUC so it doesn't linger on the admin connection.
select set_config('app.current_org', '', false);
