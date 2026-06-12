-- migrate:up

-- Extensions used by the domain schema. citext gives case-insensitive uniqueness
-- for org slugs without a functional index.
create extension if not exists citext;

-- Application database roles (plan §0.2). The request path NEVER connects
-- as the schema owner: a table owner bypasses RLS by default, so an owner connection
-- (or a SECURITY DEFINER function owned by the owner) would silently skip every
-- policy. We therefore run all tenant traffic as NON-OWNER, NOSUPERUSER,
-- NOBYPASSRLS roles, and mark every tenant table FORCE ROW LEVEL SECURITY so the
-- owner is policed too (negative control in the leak suite).
--
-- Idempotent creation: created here for local/CI (trust auth, no password needed)
-- and as a no-op when ops pre-provisions the roles in a managed environment (Neon),
-- where login credentials are injected out of band — NEVER a password literal in
-- source (no-secrets rule). Creating a LOGIN role with no password is safe: under
-- scram/md5 it simply can't authenticate until ops sets one.
--
-- Role names are mirrored in packages/db/src/constants.ts (DB_ROLES); the catalog
-- RLS-coverage test asserts the live roles match and have neither SUPERUSER nor
-- BYPASSRLS (M3).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_app') then
    create role webhook_app login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'webhook_ingest') then
    create role webhook_ingest login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

-- Both roles need to resolve objects in the schema; table/column privileges are
-- granted per table in the migrations that create them (least privilege).
grant usage on schema public to webhook_app, webhook_ingest;

-- migrate:down

-- Revoke the only privilege these roles hold at this point (schema USAGE granted in
-- the up). All per-table/function grants vanished when their objects were dropped in
-- the later migrations' downs (reverse order), so there is nothing left to DROP
-- OWNED — which is good, because a CREATEROLE owner isn't a member of these roles and
-- cannot DROP OWNED BY them. Once the dependency is revoked, DROP ROLE succeeds.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_app') then
    revoke usage on schema public from webhook_app;
    drop role webhook_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'webhook_ingest') then
    revoke usage on schema public from webhook_ingest;
    drop role webhook_ingest;
  end if;
end
$$;

drop extension if exists citext;
