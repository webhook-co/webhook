-- migrate:up

-- The bearer-verify database role (WS-D1a, ADR-0008 Option B). The api-key verify
-- path connects as this NON-OWNER, NOSUPERUSER, NOBYPASSRLS role so RLS is enforced
-- exactly like webhook_app/webhook_ingest. It holds a SELECT-only policy on api_keys
-- plus a COLUMN-level grant on (key_hash, org_id, scopes, expires_at, revoked_at) —
-- granted in the api_keys migration, never here — so a leaked credential can read key
-- metadata but cannot see display fields, forge a key, or write anything.
--
-- Created idempotently, mirroring 0002: present for local/CI (trust auth, no password
-- needed) and a no-op when ops pre-provisions the role in a managed environment (Neon),
-- where the login password is injected out of band — NEVER a password literal in source
-- (no-secrets rule). A LOGIN role with no password simply can't authenticate until ops
-- sets one.
--
-- The role name is mirrored in packages/db/src/constants.ts (DB_ROLES.authn = the
-- literal below); the catalog RLS-coverage test asserts the live role exists and has
-- neither SUPERUSER nor BYPASSRLS and owns no tables (M3).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_authn') then
    create role webhook_authn login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

-- Needs to resolve objects in the schema; the api_keys column grant is least-privilege
-- and lives in the table's own migration.
grant usage on schema public to webhook_authn;

-- migrate:down

-- Revoke the only privilege held at this point (schema USAGE). The api_keys column
-- grant vanished when that table was dropped in its later migration's down (reverse
-- order), so nothing references this role and DROP ROLE succeeds.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_authn') then
    revoke usage on schema public from webhook_authn;
    drop role webhook_authn;
  end if;
end
$$;
