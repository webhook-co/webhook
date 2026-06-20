-- migrate:up

-- Lane C A2b-2a — the OAuth refresh-token store (ADR-0024). The frozen /token issues a first-party,
-- opaque ~90d refresh handle (rtk_<orgId>_<secret>) alongside the 24h whk_ key; this table holds only
-- its HMAC-SHA256+pepper hash (mirroring api_keys — nothing reversible is stored).
--
-- The handle EMBEDS its org so the issuer resolves the tenant from the handle alone — there is NO
-- cross-org role here: every read/write is webhook_app under the normal RLS org scope. (Contrast
-- api_keys, which a resource server resolves by hash cross-org via webhook_authn — but that is a
-- read-only verify path; a refresh CONSUME is an issuer MUTATION, so we keep it tenant-scoped rather
-- than grant any role cross-org write.) The embedded org is covered by the hash, so it can't be
-- swapped to target another tenant.
--
-- Single-use is enforced at consume by ONE atomic UPDATE…FROM auth_grant that flips used_at only if the
-- handle is unused + unrevoked + unexpired AND the grant is still active; a concurrent replay loses the
-- row lock and matches nothing. See packages/db/src/refresh-token.ts.

create table auth_refresh_token (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  grant_id uuid not null,
  audience text not null,
  token_hash bytea not null unique,
  prefix text not null,
  start text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  -- The rotated successor's id (set when this handle is consumed) — a forward audit trail of the chain.
  replaced_by uuid,
  -- Composite FK (mirrors api_keys ← 0015): a refresh handle can only point at a grant in its OWN org,
  -- and revoking-by-delete a grant cascades its handles away.
  constraint auth_refresh_token_grant_org_fkey
    foreign key (grant_id, org_id) references auth_grant (id, org_id) on delete cascade,
  unique (id, org_id)
);

create index auth_refresh_token_grant_idx on auth_refresh_token (grant_id);

alter table auth_refresh_token enable row level security;
alter table auth_refresh_token force row level security;

create policy auth_refresh_token_select on auth_refresh_token
  for select using (org_id = current_org_id());
create policy auth_refresh_token_insert on auth_refresh_token
  for insert with check (org_id = current_org_id());
create policy auth_refresh_token_update on auth_refresh_token
  for update using (org_id = current_org_id()) with check (org_id = current_org_id());
-- DELETE is org-scoped like api_keys (0009): the issuer never deletes a live handle ad-hoc (rotation
-- sets used_at; grant-revoke sets revoked_at), but the future expiry-sweep job prunes spent/expired rows.
create policy auth_refresh_token_delete on auth_refresh_token
  for delete using (org_id = current_org_id());

-- webhook_app owns the whole refresh lifecycle (issue on /token mint, atomic consume+rotate on refresh,
-- revoke on grant-revoke, expiry-sweep prune). Full CRUD, RLS-org-scoped — symmetric with api_keys.
grant select, insert, update, delete on auth_refresh_token to webhook_app;

-- migrate:down

drop policy if exists auth_refresh_token_delete on auth_refresh_token;
drop policy if exists auth_refresh_token_update on auth_refresh_token;
drop policy if exists auth_refresh_token_insert on auth_refresh_token;
drop policy if exists auth_refresh_token_select on auth_refresh_token;
drop table if exists auth_refresh_token;
