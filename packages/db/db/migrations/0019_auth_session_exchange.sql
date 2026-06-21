-- migrate:up

-- Lane C A-SX-1 — the auth.→app. session-exchange store. auth.webhook.co and app.webhook.co are separate
-- origins with HOST-ONLY session cookies (no shared `.webhook.co` cookie — founder X-2), so after login at
-- auth. the user is handed a single-use, short-TTL, opaque ticket (`sxt_<orgId>_<secret>`) bound to the
-- app. origin (`audience`); app.'s server redeems it BACKCHANNEL at /session/exchange (A-SX-2) to establish
-- its own session. Only the HMAC-SHA256+pepper hash of the handle is stored — nothing reversible.
--
-- Same org-embedded-handle model as the refresh store (0017): the org segment routes the tenant lookup so
-- the redeem stays webhook_app under the normal RLS org scope — NO cross-org role. The hash covers the
-- WHOLE plaintext, so the embedded org can't be swapped to target another tenant. Single-use is the one
-- atomic UPDATE…used_at at consume (a replay loses the row lock and matches nothing).
--
-- The principal's PROFILE (name/email/image) is deliberately NOT stored here — it's read fresh from the
-- better-auth `user` row at redeem time (A-SX-2, via the webhook_auth role), so no identity PII is
-- denormalized into this tenant table and the redeemed profile is never stale.

create table auth_session_exchange (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  -- The better-auth user id the ticket authenticates (no FK: `user` is the identity realm, not a tenant
  -- table, and webhook_app can't reference it — the ticket is short-lived + the profile is read at redeem).
  user_id text not null,
  -- The origin the ticket may be redeemed for (e.g. https://app.webhook.co) — matched at consume so a
  -- ticket minted for one app can't be redeemed by another.
  audience text not null,
  token_hash bytea not null unique,
  prefix text not null,
  start text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  unique (id, org_id)
);

alter table auth_session_exchange enable row level security;
alter table auth_session_exchange force row level security;

create policy auth_session_exchange_select on auth_session_exchange
  for select using (org_id = current_org_id());
create policy auth_session_exchange_insert on auth_session_exchange
  for insert with check (org_id = current_org_id());
create policy auth_session_exchange_update on auth_session_exchange
  for update using (org_id = current_org_id()) with check (org_id = current_org_id());
-- DELETE is org-scoped (the future expiry-sweep job prunes spent/expired rows; consume sets used_at).
create policy auth_session_exchange_delete on auth_session_exchange
  for delete using (org_id = current_org_id());

-- webhook_app owns the whole exchange lifecycle (mint at login-handoff, atomic consume at redeem,
-- expiry-sweep prune). Full CRUD, RLS-org-scoped — symmetric with auth_refresh_token.
grant select, insert, update, delete on auth_session_exchange to webhook_app;

-- migrate:down

drop policy if exists auth_session_exchange_delete on auth_session_exchange;
drop policy if exists auth_session_exchange_update on auth_session_exchange;
drop policy if exists auth_session_exchange_insert on auth_session_exchange;
drop policy if exists auth_session_exchange_select on auth_session_exchange;
drop table if exists auth_session_exchange;
