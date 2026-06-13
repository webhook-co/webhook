-- migrate:up

-- Org-scoped API keys under RLS + FORCE (WS-D1a, ADR-0008 Option B). Mirrors the
-- ingest-token discipline (ADR-0003): a CSPRNG >=256-bit secret is shown ONCE at
-- creation and NEVER stored; only its hash is persisted, and lookups/verification go
-- by hash.
--
-- S4 — hash choice: key_hash is a FAST sha256 of the plaintext key, intentionally,
-- exactly like endpoints.ingest_token_hash. The secret is a >=256-bit CSPRNG value, so
-- a slow/keyed hash (argon2/bcrypt/HMAC) would be cargo-culting — those defend
-- LOW-entropy human passwords against offline brute force. There is nothing to brute
-- force here. Do NOT "upgrade" this to a slow hash.
--
-- Ids are UUIDv7, edge-generated (no DB default) for index locality + a stable cursor
-- tiebreaker, like every other tenant table (§0.10). This is the EXPAND half of the
-- expand->contract in ADR-0008: better-auth's `apikey` table stays (its RLS exemption
-- is removed only in a LATER contract migration once nothing reads it).

create table api_keys (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  -- sha256(plaintext key) — the plaintext is shown once and never stored (S4 above).
  key_hash bytea not null unique,
  -- Display-only, non-secret: a short, human-recognizable handle for the key in lists.
  prefix text not null,
  start text not null,
  name text not null,
  -- Capability scopes (e.g. ["events:read"]); the verify path returns these to the caller.
  scopes jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same composite org-binding target other tenant tables expose, so any future child
  -- (id, org_id) FK can never cross an org boundary (defense-in-depth on top of RLS).
  unique (id, org_id)
);

create index api_keys_org_idx on api_keys (org_id, created_at desc);

alter table api_keys enable row level security;
alter table api_keys force row level security;

-- webhook_app: deny-by-default, per-command policies gating on current_org_id() (an
-- unset context -> NULL -> zero rows), identical to every other tenant table. These
-- policies are PERMISSIVE and untargeted at a role, but webhook_app is the only role
-- with DML privileges (granted below), so they govern the app's full create/list/
-- revoke path.
create policy api_keys_select on api_keys for select using (org_id = current_org_id());
create policy api_keys_insert on api_keys for insert with check (org_id = current_org_id());
create policy api_keys_update on api_keys for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy api_keys_delete on api_keys for delete using (org_id = current_org_id());
grant select, insert, update, delete on api_keys to webhook_app;

-- webhook_authn (S2): the bearer-verify role gets a SEPARATE, role-TARGETED SELECT
-- policy. It is FOR SELECT TO webhook_authn only — never a bare USING(true) that
-- webhook_app could also ride. Verification still resolves under a server-derived org
-- context, so the row-level USING(true) is the role's read gate while the COLUMN grant
-- below is what bounds WHICH columns it can ever read.
create policy api_keys_authn_select on api_keys for select to webhook_authn using (true);

-- S2 — COLUMN-level grant (NOT table-level): webhook_authn may read ONLY the columns
-- the verify seam needs. It must NEVER see name, prefix, start, or any timestamp other
-- than expires_at/revoked_at. With no INSERT/UPDATE/DELETE grant it cannot write, so a
-- leaked authn credential can enumerate key metadata but cannot forge or use a key
-- (key_hash is a non-reversible sha256 of a >=256-bit secret). See docs/threat-model.md.
grant select (key_hash, org_id, scopes, expires_at, revoked_at) on api_keys to webhook_authn;

-- migrate:down

drop table if exists api_keys;
