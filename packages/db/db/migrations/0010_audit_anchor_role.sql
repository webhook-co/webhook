-- migrate:up

-- The WORM-anchor database role (WS-C2, ADR-0004). The periodic head-anchor cron must
-- read EVERY org's audit-chain head to checkpoint it to R2 — an inherently cross-org,
-- control-plane read. `audit_log` is FORCE ROW LEVEL SECURITY, so even the table owner is
-- subject to RLS; only SUPERUSER or a BYPASSRLS role could bypass it, and this codebase
-- forbids both on the request/job path (a leak test asserts the owner can't bypass). The
-- RLS-native way to grant one role a cross-org read WITHOUT bypassing RLS is a
-- role-TARGETED permissive policy — the exact pattern webhook_authn uses for api_keys
-- (0009). A SECURITY DEFINER function would NOT work here: it runs as the owner, which
-- FORCE RLS keeps subject to policies, so it would see zero rows.
--
-- webhook_anchor is a NON-OWNER, NOSUPERUSER, NOBYPASSRLS role, created idempotently and
-- mirroring 0002/0008: present for local/CI (trust auth), a no-op when ops pre-provisions
-- it in a managed environment (Neon) where the login password is injected out of band —
-- never a password literal in source (no-secrets). The role name is mirrored in
-- packages/db/src/constants.ts (DB_ROLES.anchor); the catalog RLS tests assert it has
-- neither SUPERUSER nor BYPASSRLS and owns no tables (M3).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_anchor') then
    create role webhook_anchor login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_anchor;

-- Role-targeted SELECT policy: FOR SELECT TO webhook_anchor only — never a bare
-- USING(true) that webhook_app could also ride. Permissive policies OR together, but
-- this one is scoped to webhook_anchor, so webhook_app still sees only its own org via
-- audit_log_select. This is the cross-org read gate; the COLUMN grant below bounds WHICH
-- columns it can ever read. The catalog test that dedups policy commands per table is
-- unaffected (audit_log stays INSERT+SELECT).
create policy audit_log_anchor_select on audit_log for select to webhook_anchor using (true);

-- COLUMN-level grant (NOT table-level): the anchor cron reads ONLY the chain-head fields
-- it needs — org_id, seq, and the row_hash (a non-reversible HMAC tag). It must NEVER see
-- actor/action/target (the control-plane audit content). With no INSERT/UPDATE/DELETE
-- grant it cannot write, and the immutability triggers protect the chain regardless. A
-- leaked webhook_anchor credential can enumerate per-org chain heads across tenants but
-- cannot read audit content, forge a row (the HMAC key lives outside the DB), or alter
-- history. See docs/threat-model.md.
grant select (org_id, seq, row_hash) on audit_log to webhook_anchor;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_anchor') then
    revoke select (org_id, seq, row_hash) on audit_log from webhook_anchor;
    drop policy if exists audit_log_anchor_select on audit_log;
    revoke usage on schema public from webhook_anchor;
    drop role webhook_anchor;
  end if;
end
$$;
