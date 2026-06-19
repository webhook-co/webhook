-- migrate:up

-- The api_keys credential extension (Lane B A0a; ADR-0010 r5/r6). Adds the per-key RFC 8707
-- audience (the future-OAuth seam that credential-resolver.ts documents), the grant parent FK
-- (grant-revoke cascades to its keys, A0c), the owner type, and the SSO-authorization flag.
-- All additive / expand-only:
--   * audience       nullable — null = a legacy/org-wide key (stamped with the presenting
--                    surface's audience at resolve time, the back-compat path); a set value
--                    confines the key to one surface (an OAuth-minted key, A0c).
--   * grant_id       PERMANENTLY nullable — null = a standalone/directly-created key (createApiKey);
--                    set = an OAuth/device-grant-backed key. Standalone keys are a permanent part of
--                    the model (no NOT-NULL contract). on delete cascade: dropping a grant drops its
--                    minted keys (the row-level cascade; the app-level revoke-cascade is A0c).
--   * owner_type     NOT NULL DEFAULT 'user' — a constant default is metadata-only (no table rewrite)
--                    and backfills existing rows to 'user'; keys default user-owned.
--   * sso_authorized nullable — designed-in for the GitHub-style SSO-authorization gate; unenforced in v1.
alter table api_keys add column audience text;
alter table api_keys add column grant_id uuid references auth_grant (id) on delete cascade;
alter table api_keys add column owner_type text not null default 'user' check (owner_type in ('user', 'org'));
alter table api_keys add column sso_authorized boolean;
create index api_keys_grant_idx on api_keys (grant_id);

-- Extend the webhook_authn cold-path column grant to include `audience` so makeApiKeyColdLookup can
-- read a per-key audience (the conditional stamp, A0b). Deliberately NOT grant_id/owner_type/
-- sso_authorized — the cold path needs only the audience; don't widen the authn read surface.
grant select (audience) on api_keys to webhook_authn;

-- migrate:down

drop index if exists api_keys_grant_idx;
alter table api_keys drop column if exists sso_authorized;
alter table api_keys drop column if exists owner_type;
alter table api_keys drop column if exists grant_id;
alter table api_keys drop column if exists audience;
