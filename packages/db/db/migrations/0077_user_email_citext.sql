-- migrate:up

-- Make user.email case-insensitive-unique by converting it from `text` to `citext`.
--
-- Why: Better Auth's "user".email was `text` (case-sensitive) with an inline UNIQUE, while the identity it is
-- matched against — org_invites.invited_email (0064) and orgs.slug (0003) — is already `citext`. So at the
-- DATABASE boundary, "A@x.com" and "a@x.com" were two distinct, both-insertable rows. Better Auth itself
-- lowercases email on every write and lookup (internal-adapter createUser/findUserByEmail), so in practice no
-- duplicate arises via the app — but the guarantee lived in application code, not the schema, and any non-BA
-- writer (a direct insert, an ops fix, a future first-party path) could still create a case-variant twin.
-- citext moves the invariant into the database, where an email-change flow can rely on it.
--
-- citext is already installed cluster-wide (0002). This is the FIRST migration to ALTER the TYPE of a Better
-- Auth GENERATOR-owned column (0073 only ADDed columns). The generator cannot emit citext, so the checked-in
-- mirror .better-auth.schema.sql stays `text` and the CI drift guard — which diffs the mirror against fresh
-- generator output, never against the live DB — stays green. The live column type therefore INTENTIONALLY
-- diverges from the mirror for this one column; see ADR-0119.
--
-- text -> citext is not binary-coercible, so the dependent UNIQUE must be dropped before the ALTER and
-- recreated after. The recreated constraint is case-INSENSITIVE (citext equality). "user" is an RLS-exempt
-- identity table owned by webhook_owner; no RLS/GRANT interaction (the webhook_notifier column grant on
-- (id, email) survives a type change — grants are by column name).
--
-- PRE-FLIGHT (prod, MANDATORY): the recreated UNIQUE build ABORTS (cleanly, txn rolls back) if two users
-- collide case-insensitively. Because BA has always lowercased on write, the expected count is ZERO. Confirm
-- (run as webhook_auth or the owner — webhook_app cannot read "user"):
--   select lower(email) as normalized, count(*), array_agg(id order by "createdAt"), array_agg(email)
--   from "user" group by lower(email) having count(*) > 1;
-- If any collide, resolve manually (the identities are distinct accounts — a human must decide) before
-- applying; do NOT auto-merge users in a migration.

alter table "user" drop constraint "user_email_key";
alter table "user" alter column "email" type citext using "email"::citext;
alter table "user" add constraint "user_email_key" unique ("email");

-- migrate:down

alter table "user" drop constraint "user_email_key";
alter table "user" alter column "email" type text using "email"::text;
alter table "user" add constraint "user_email_key" unique ("email");
