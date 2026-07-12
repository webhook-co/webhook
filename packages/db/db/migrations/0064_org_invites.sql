-- migrate:up

-- org_invites — a pending invitation for someone to JOIN an org at a role (Lane 2.5). The invite carries a
-- ≥256-bit CSPRNG token shown once (in the emailed link) and stored ONLY as a keyed hash (same discipline as
-- api keys / ingest tokens, ADR-0003/0008): the plaintext never touches the DB, and accept looks the invite
-- up by hash. Single-use — accept flips accepted_at once, under RLS, in the same transaction as the
-- membership insert. Tenant-scoped like every org-child table (FORCE RLS, org_id = current_org_id()); the
-- accepting flow already knows the org (it's in the invite link), so lookup-by-token stays on webhook_app
-- RLS with no cross-org scan.
create table org_invites (
  id uuid not null,
  org_id uuid not null references orgs (id) on delete cascade,
  -- HMAC(pepper, token) — the ONLY copy of the secret. Unique so accept is an exact by-hash lookup.
  token_hash bytea not null,
  -- Non-secret display handle (the token's first chars), for listing an invite without the secret.
  start text not null,
  -- Case-insensitive: the accepting user's email must match, regardless of case. Non-empty (a blank email
  -- would match a blank accept email — fail-open corner closed here + in createInvite).
  invited_email citext not null check (length(btrim(invited_email::text)) > 0),
  role text not null check (role in ('owner', 'admin', 'member')),
  -- The inviter, and who accepted — SET NULL on erasure (never cascade-delete an invite row / audit trail).
  invited_by text references "user" (id) on delete set null,
  accepted_by text references "user" (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id)
);
alter table org_invites enable row level security;
alter table org_invites force row level security;
create policy org_invites_select on org_invites for select using (org_id = current_org_id());
create policy org_invites_insert on org_invites for insert with check (org_id = current_org_id());
create policy org_invites_update on org_invites for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy org_invites_delete on org_invites for delete using (org_id = current_org_id());
grant select, insert, update, delete on org_invites to webhook_app;

-- Accept looks up by token_hash; unique makes it an exact, index-served match (mirrors api_keys.key_hash).
create unique index org_invites_token_hash_idx on org_invites (token_hash);
-- List / dedup pending invites for an org by email.
create index org_invites_email_idx on org_invites (org_id, invited_email);

-- migrate:down

drop table if exists org_invites;
