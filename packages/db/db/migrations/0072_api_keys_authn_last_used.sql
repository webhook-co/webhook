-- migrate:up

-- Let the verify cold path record api_keys.last_used_at. Until now the column (0009) was written by NOTHING,
-- so every key reported "last used: never" — a real gap for key-hygiene / rotation. The cold lookup runs as
-- webhook_authn (a `nosuperuser nobypassrls`, SELECT-only role, over the CACHE-DISABLED HYPERDRIVE_AUTHN
-- binding, which reaches the writable primary). To let it stamp last_used_at — and ONLY last_used_at — it
-- needs BOTH a column-scoped UPDATE grant AND a role-scoped UPDATE policy, because api_keys is FORCE ROW
-- LEVEL SECURITY and webhook_authn does not bypass it: a grant alone is checked by no policy and denied.
--
-- This is webhook_authn's FIRST write privilege of any kind, and it is deliberately the narrowest possible:
--   * `grant update (last_used_at)` ONLY — it cannot write any other column (rls.test.ts asserts this, so a
--     future widening trips a red test).
--   * `grant select (last_used_at)` too, because the throttle is conditional: the stamp UPDATE's WHERE reads
--     `last_used_at` (`... < now() - window`) to skip a recently-written row, and Postgres requires SELECT on
--     any column read in a statement. last_used_at is a low-sensitivity timestamp (not key material, not PII),
--     and the coarse-write coalescing this buys — one write per key per window GLOBALLY, instead of one per
--     PoP per cache-TTL — is worth the read. It remains blocked from name/created_by/prefix/etc.
--   * `USING (true)`: the cold path has NO org context (org-discovery-by-hash), exactly like the SELECT
--     policy `api_keys_authn_select` (0009) — the row is identified by key_hash, not current_org_id().
--   * `WITH CHECK (true)`: safe precisely because the column grant already forecloses changing anything but
--     last_used_at. WITH CHECK governs the post-update row's VALUES, not WHICH columns may change (that is the
--     grant's job), so a stricter clause here would be redundant, not additional protection.
--
-- The stamp itself is best-effort and throttled in the application: fired via ctx.waitUntil (OFF the auth
-- response, so a write fault can never fail authentication) and re-written only past a staleness window, so a
-- hot key is stamped at most once per window, not once per request.
grant select (last_used_at) on api_keys to webhook_authn;
grant update (last_used_at) on api_keys to webhook_authn;

create policy api_keys_authn_last_used on api_keys
  for update to webhook_authn
  using (true)
  with check (true);

-- migrate:down

drop policy if exists api_keys_authn_last_used on api_keys;
revoke update (last_used_at) on api_keys from webhook_authn;
revoke select (last_used_at) on api_keys from webhook_authn;
