-- migrate:up

-- Data minimization (compliance-by-design): webhook.co uses social OAuth (Google/GitHub) for IDENTITY ONLY.
-- Nothing reads the provider tokens Better Auth stores on `account` — accessToken (a short-lived API bearer
-- we never spend), refreshToken (only issued with offline access, which we don't request), and idToken (an
-- OIDC JWT consumed at sign-in, stale afterward). They are pure plaintext-at-rest liability. Going forward,
-- the auth runtime's account databaseHooks (account-token-hooks.ts) refuse to persist them on every write;
-- this migration is the ONE-SHOT backfill that nulls any rows written before that hook shipped.
--
-- Idempotent + safe: nulling an already-null column is a no-op, and the identity-linking columns
-- (accountId/providerId/userId) are untouched, so no login or account link is affected. NOT reversible by
-- design — the down is a no-op because the whole point is to destroy secrets we should never have kept, and
-- the real provider tokens cannot (and must not) be reconstructed.
update "account"
set "accessToken" = null,
    "refreshToken" = null,
    "idToken" = null
where "accessToken" is not null
   or "refreshToken" is not null
   or "idToken" is not null;

-- migrate:down

-- Intentionally irreversible: the stripped provider OAuth tokens are secrets we deliberately discarded and
-- cannot restore. Nothing reads these columns, so leaving them null on a rollback is correct.
select 1;
