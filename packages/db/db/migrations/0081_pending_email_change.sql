-- migrate:up

-- The in-flight email-change step-up state: one row per user while they're mid-ceremony. A 6-digit OTP is
-- sent to the user's CURRENT email (proving control of the address on record); its HASH — never the code — is
-- stored here, single-use, short-TTL, and re-verified at commit. Identity-realm (user-scoped, no org), so it
-- lives OUTSIDE per-org RLS alongside user/session/account/verification, and DML is GRANTed to the auth
-- runtime role ONLY (webhook_app must never read OTP hashes). Added to RLS_EXEMPT in rls.test.ts with this
-- reason.
--
-- `unique(user_id)`: at most one pending change at a time — starting a new one replaces the old (the ceremony
-- upserts). FK to "user" with ON DELETE CASCADE so a deleted account drops any pending change with it.

create table pending_email_change (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user"("id") on delete cascade,
  new_email citext not null,
  code_hash bytea not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id)
);

-- The auth runtime (webhook_auth, non-owner, nobypassrls) manages this like the other identity tables. No
-- grant to webhook_app — the OTP hash is not readable from the tenant/app role.
grant select, insert, update, delete on pending_email_change to webhook_auth;

-- migrate:down

revoke all privileges on pending_email_change from webhook_auth;
drop table pending_email_change;
