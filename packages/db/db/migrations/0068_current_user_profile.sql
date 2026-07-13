-- migrate:up

-- current_user_profile() — the ONLY way webhook_app may read its own caller's identity.
--
-- The signup bootstrap names a user's personal org after them: the org's `name` is their display name, and
-- its `slug` — which is about to become the org's URL (/org/{slug}/…) — is derived from it. But Better Auth's
-- session row carries ONLY a userId, so the session-create self-heal (the path that rescues a user whose
-- signup bootstrap failed) has no name and no email to work from. It was therefore naming those orgs
-- "Personal", at `/org/org-<hex>/`, permanently — `on conflict (id) do nothing` means nothing ever repairs it,
-- and there is no rename path.
--
-- Fixing that needs the profile, which lives in `"user"` — Better Auth's GLOBAL identity table. And
-- webhook_app has NO grant on `"user"`, deliberately and by design: it is not row-level-secured (it is
-- written by webhook_auth on the login path and has no org column to police), so a plain `select` grant would
-- put tenant isolation in the hands of every present and future query author remembering to filter it. That
-- is app-layer filtering as the sole isolation mechanism, which the data rule forbids. `rls.test.ts` asserts
-- the refusal outright: "webhook_app cannot read the identity table directly — the function is the ONLY path".
--
-- So this follows the same confinement as org_member_directory() (0066) and user_org_directory() (0067):
--   * SECURITY DEFINER runs as the migration owner, who may read `"user"`;
--   * it takes NO ARGUMENT — it reads current_app_user(), so it cannot be pointed at an arbitrary user by
--     passing one in; the GUC is set by withUser() from a server-authenticated id, never from request input;
--   * an UNSET GUC yields current_app_user() = NULL -> `u.id = NULL` -> ZERO rows. Deny-by-default: an
--     unscoped call returns nothing, not the whole table;
--   * search_path is pinned, so a SECURITY DEFINER search-path hijack cannot redirect `"user"`;
--   * it returns name + email ONLY — not the password hash, not the id, not anything else on the row.
--
-- The result is unchanged from before: there is still no reachable query by which the tenant role can read a
-- user other than the one whose id the application has already authenticated.
create function current_user_profile()
  returns table (name text, email text)
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select u.name, u.email
      from "user" u
     where u.id = current_app_user()
  $$;

grant execute on function current_user_profile() to webhook_app;

-- migrate:down

drop function if exists current_user_profile();
