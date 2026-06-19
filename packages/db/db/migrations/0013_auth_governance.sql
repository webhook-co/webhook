-- migrate:up

-- Governance-ready credential schema (ADR-0010 r6, Lane B A0a). Three tables under the
-- canonical tenant-RLS discipline (mirrors 0003): auth_grant (the device/login grant a minted
-- whk_ key hangs off), org_policy (one nullable row per org — governance designed-in, enforced
-- later), and auth_audit_event (the control-plane audit chain, mirroring audit_log 0005). The
-- api_keys audience/grant_id/owner_type/sso_authorized columns are added in 0014.

-- auth_grant ---------------------------------------------------------------------
-- One row per CLI/web login (a device-authorization grant). A minted whk_ api key is its child
-- (api_keys.grant_id, 0014); grant-revoke cascades to the keys (A0c). user_id is the Better Auth
-- user id (text, like memberships); actor_type is enum-now-for-future (app-enforced 'user' in v1).
create table auth_grant (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  actor_type text not null default 'user',
  device_name text,
  device_fingerprint text,
  created_at timestamptz not null default now(),
  created_ip inet,
  created_geo jsonb,
  last_used_at timestamptz,
  last_used_ip inet,
  last_used_geo jsonb,
  status text not null check (status in ('pending_approval', 'active', 'revoked', 'expired')),
  expires_at timestamptz,
  auth_method text not null check (auth_method in ('pkce_loopback', 'device_code')),
  sso_identity_id text,
  approved_by text references "user" (id),
  approved_at timestamptz,
  revoked_by text references "user" (id),
  revoked_at timestamptz,
  revocation_reason text,
  unique (id, org_id)
);
create index auth_grant_org_status_idx on auth_grant (org_id, status);
create index auth_grant_user_status_idx on auth_grant (user_id, status);
alter table auth_grant enable row level security;
alter table auth_grant force row level security;
create policy auth_grant_select on auth_grant for select using (org_id = current_org_id());
create policy auth_grant_insert on auth_grant for insert with check (org_id = current_org_id());
create policy auth_grant_update on auth_grant for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy auth_grant_delete on auth_grant for delete using (org_id = current_org_id());
grant select, insert, update, delete on auth_grant to webhook_app;

-- org_policy ---------------------------------------------------------------------
-- One row per org; EVERY governance field is nullable = unset, so enabling a control later is
-- data, not a migration. Only auto_approve_rules has live logic in v1 (the A0c evaluator); the
-- rest are schema-only until the admin-console epic. require_device_approval null/false = OFF.
create table org_policy (
  org_id uuid primary key references orgs (id) on delete cascade,
  require_device_approval boolean,
  max_credential_ttl interval,
  allowed_scopes jsonb,
  force_reauth_interval interval,
  sso_required boolean,
  block_long_lived_keys boolean,
  max_long_lived_keys integer,
  require_mfa boolean,
  auto_approve_rules jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table org_policy enable row level security;
alter table org_policy force row level security;
create policy org_policy_select on org_policy for select using (org_id = current_org_id());
create policy org_policy_insert on org_policy for insert with check (org_id = current_org_id());
create policy org_policy_update on org_policy for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy org_policy_delete on org_policy for delete using (org_id = current_org_id());
grant select, insert, update, delete on org_policy to webhook_app;

-- auth_audit_event ---------------------------------------------------------------
-- Control-plane auth audit, append-only + per-org hash-chained — same discipline as audit_log
-- (0005): the DB enforces chain STRUCTURE (contiguous seq, prev_hash linked, immutable); the APP
-- supplies row_hash = HMAC(key, prev_hash || canonical(fields)) with the key OUTSIDE the DB role
-- and the canonical form frozen in packages/db (the `aae1` canon, A0c). A SEPARATE chain from
-- audit_log: distinct fields (event_type/target_id/ip/geo/metadata) + a distinct canon version,
-- so the frozen audit_log `wha1` chain is untouched. actor is the pseudonymous user_id or
-- 'system' (text, not a FK — survives user erasure).
create table auth_audit_event (
  id bigserial primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  seq bigint not null,
  actor text,
  event_type text not null check (event_type in (
    'login', 'grant_created', 'grant_approved', 'grant_revoked',
    'key_minted', 'key_revoked', 'policy_changed', 'reauth')),
  target_id text,
  ip inet,
  geo jsonb,
  metadata jsonb,
  prev_hash bytea,
  row_hash bytea not null,
  created_at timestamptz not null default now(),
  unique (org_id, seq)
);
create index auth_audit_event_org_created_idx on auth_audit_event (org_id, created_at desc);
create index auth_audit_event_org_type_idx on auth_audit_event (org_id, event_type, created_at desc);

-- Chain-integrity on insert (mirrors audit_log_chain): contiguous per-org seq + prev_hash linked
-- to the prior row_hash; genesis (seq 1) has null prev_hash. INVOKER under the caller's RLS;
-- unique (org_id, seq) is the concurrency serialization point.
create function auth_audit_event_chain() returns trigger
  language plpgsql
  as $$
declare
  prev_seq bigint;
  prev_row_hash bytea;
begin
  new.created_at := now();
  select a.seq, a.row_hash into prev_seq, prev_row_hash
    from auth_audit_event a
    where a.org_id = new.org_id
    order by a.seq desc
    limit 1;
  if prev_seq is null then
    if new.seq <> 1 then
      raise exception 'auth_audit_event chain for org % must start at seq 1 (got %)', new.org_id, new.seq
        using errcode = 'check_violation';
    end if;
    if new.prev_hash is not null then
      raise exception 'auth_audit_event genesis row (seq 1) must have null prev_hash'
        using errcode = 'check_violation';
    end if;
  else
    if new.seq <> prev_seq + 1 then
      raise exception 'auth_audit_event seq must be contiguous for org %: expected % got %',
        new.org_id, prev_seq + 1, new.seq
        using errcode = 'check_violation';
    end if;
    if new.prev_hash is distinct from prev_row_hash then
      raise exception 'auth_audit_event prev_hash must equal the prior row_hash for org %', new.org_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
create trigger auth_audit_event_chain_biu before insert on auth_audit_event
  for each row execute function auth_audit_event_chain();

-- Immutability: reject UPDATE/DELETE (row-level) and TRUNCATE (statement-level), mirroring
-- audit_log_immutable — append-only grants alone aren't enough; the owner could edit history.
create function auth_audit_event_immutable() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'auth_audit_event is append-only: % is not permitted', tg_op
    using errcode = 'check_violation';
end
$$;
create trigger auth_audit_event_no_update before update on auth_audit_event
  for each row execute function auth_audit_event_immutable();
create trigger auth_audit_event_no_delete before delete on auth_audit_event
  for each row execute function auth_audit_event_immutable();
create trigger auth_audit_event_no_truncate before truncate on auth_audit_event
  for each statement execute function auth_audit_event_immutable();

alter table auth_audit_event enable row level security;
alter table auth_audit_event force row level security;
-- INSERT + SELECT only (read needed to compute prev_hash + for verification/export); UPDATE/DELETE
-- are deny-by-default (no policy) on top of the trigger and the withheld privileges.
create policy auth_audit_event_select on auth_audit_event for select using (org_id = current_org_id());
create policy auth_audit_event_insert on auth_audit_event for insert with check (org_id = current_org_id());
grant select, insert on auth_audit_event to webhook_app;
grant usage, select on sequence auth_audit_event_id_seq to webhook_app;

-- migrate:down

drop table if exists auth_audit_event;
drop function if exists auth_audit_event_immutable();
drop function if exists auth_audit_event_chain();
drop table if exists org_policy;
drop table if exists auth_grant;
