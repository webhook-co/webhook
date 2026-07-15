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
-- Post-index, the concurrent-callback race that used to SILENTLY create a duplicate now instead fails the
-- losing insert cleanly (23505) — Better Auth surfaces a retryable sign-in error, and the next attempt
-- resolves against the winning row. That is strictly better than the prior silent corruption.
--
-- account is an RLS-EXEMPT global identity table (0001), owned by webhook_owner and DML'd by the non-bypass
-- webhook_auth role (0016) — a plain btree unique here has no RLS/policy interaction and needs no GRANT
-- change. NOT created CONCURRENTLY: dbmate wraps each migration in a transaction (CONCURRENTLY can't run in
-- one), and on this deployment the account table is tiny (a handful of identities), so the brief write lock
-- during the build is negligible. Revisit CONCURRENTLY only if account ever grows large.
--
-- PRE-FLIGHT (prod, MANDATORY): a unique-index build ABORTS (cleanly, no data change — the txn rolls back)
-- if a duplicate pair already exists. This migration deliberately does NOT auto-delete rows: silently
-- erasing identity rows in a migration is riskier than a loud, operator-resolved failure. Before applying,
-- confirm there are none:
--   select "providerId", "accountId", count(*)
--   from "account" group by "providerId", "accountId" having count(*) > 1;
-- Expected: zero rows on this deployment. If any appear, de-dup KEEPING THE EARLIEST by "createdAt", then
-- re-apply:
--   delete from "account" a
--   using "account" b
--   where a."providerId" = b."providerId" and a."accountId" = b."accountId"
--     and (a."createdAt" > b."createdAt" or (a."createdAt" = b."createdAt" and a."id" > b."id"));

create unique index "account_providerId_accountId_idx" on "account" ("providerId", "accountId");

-- migrate:down

drop index if exists "account_providerId_accountId_idx";
