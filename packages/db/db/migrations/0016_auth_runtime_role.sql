-- migrate:up

-- The Better Auth runtime database role (Lane C A1; follows the least-privilege,
-- non-bypass role model of ADR-0008 / migration 0002, for the auth runtime of ADR-0010).
-- The auth.webhook.co Worker connects as this NON-OWNER, NOSUPERUSER, NOBYPASSRLS role to
-- manage the GLOBAL Better Auth identity tables (user/session/account/verification),
-- which are intentionally RLS-EXEMPT (0001) — so a non-bypass role operates on them
-- with plain table DML and no policies. It holds DML on exactly those four tables plus
-- schema USAGE, and NOTHING else: not the org-scoped tenant tables (those stay
-- webhook_app's, RLS-enforced) and not the plugin `apikey` table (generator-config-only,
-- ADR-0019 — every runtime key is a first-party api_keys row minted by Lane B, never the
-- plugin table). The signup→bootstrap path runs on a SEPARATE driver/role (webhook_app
-- under withTenant, postgres.js) — see Lane C A1's runtime; this role never touches
-- tenant data.
--
-- Created idempotently, mirroring 0002/0008: present for local/CI (trust auth, no
-- password) and a no-op when ops pre-provisions the role in a managed environment (Neon),
-- where the login password is injected out of band — NEVER a password literal in source
-- (no-secrets rule). A LOGIN role with no password simply can't authenticate until ops
-- sets one.
--
-- The role name is mirrored in packages/db/src/constants.ts (DB_ROLES.auth = the literal
-- below); the catalog RLS-coverage test asserts the live role exists, has neither
-- SUPERUSER nor BYPASSRLS, owns no tables, and holds DML on the identity tables only.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_auth') then
    create role webhook_auth login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

-- Resolve objects in the schema; the table DML below is the role's only object privilege.
grant usage on schema public to webhook_auth;

-- Full CRUD on the four global identity tables Better Auth manages at runtime. The text
-- ids carry no sequences, so no sequence grants are needed.
grant select, insert, update, delete on "user", "session", "account", "verification"
  to webhook_auth;

-- migrate:down

-- Revoke every privilege held at this point, then drop the role. The identity tables
-- still exist here (0001's down runs later, in reverse order), so the table grants must
-- be revoked explicitly before DROP ROLE can succeed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_auth') then
    revoke all privileges on "user", "session", "account", "verification" from webhook_auth;
    revoke usage on schema public from webhook_auth;
    drop role webhook_auth;
  end if;
end
$$;
