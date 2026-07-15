-- migrate:up

-- A UNIQUE index on the Better Auth identity pair ("providerId", "accountId").
--
-- Why: this pair is a stable external identity ("github" + the GitHub numeric user id, "google" + the
-- Google sub). Better Auth's adapter looks an account up by exactly this pair on every social sign-in and
-- link. Until now there was NO uniqueness on it and only a "userId" index — so the lookup was a seq scan,
-- and two concurrent OAuth callbacks for the same identity could race into TWO account rows. A duplicated
-- identity makes the "which account is this?" answer nondeterministic — a latent, hard-to-debug foothold
-- right where an email-change / account-linking surface is about to land. A unique index makes the
-- duplicate state unrepresentable at the database and turns the lookup into an index probe.
--
-- account is an RLS-EXEMPT global identity table (0001), owned by webhook_owner and DML'd by the non-bypass
-- webhook_auth role (0016) — a plain btree unique here has no RLS/policy interaction and needs no GRANT
-- change. This is not created CONCURRENTLY: dbmate wraps each migration in a transaction, the table is
-- tiny, and the brief lock is acceptable.
--
-- PRE-FLIGHT (prod): a unique index build FAILS (cleanly, no data change) if a duplicate pair already
-- exists. Before applying to prod, confirm there are none:
--   select "providerId", "accountId", count(*)
--   from "account" group by "providerId", "accountId" having count(*) > 1;
-- Expect zero rows. If any appear, de-dup (keep the earliest by "createdAt", delete the rest) first.

create unique index "account_providerId_accountId_key" on "account" ("providerId", "accountId");

-- migrate:down

drop index if exists "account_providerId_accountId_key";
