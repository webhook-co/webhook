# ADR 0055 — cross-org auth-token expiry cron-sweep via a least-privilege `webhook_sweeper` role

- status: accepted
- date: 2026-06-23
- scope: `packages/db` (migration `0020_auth_sweeper_role.sql`, `DB_ROLES.sweeper`, `pruneAllExpiredAuthTokens`
  in `src/sweep.ts`); `apps/auth` (the `scheduled()` cron handler in `src/worker.ts`, `runtime/sweep-cron.ts`,
  the `HYPERDRIVE_SWEEPER` binding + cron trigger in `wrangler.jsonc`, the `<HYPERDRIVE_SWEEPER_ID>` overlay in
  `scripts/gen-wrangler-prod.mjs`).
- relates: [ADR-0008](0008-api-key-table-rls-posture.md) (the non-bypass, least-privilege role model + the
  role-targeted-policy posture); migration `0010_audit_anchor_role.sql` (the `webhook_anchor` role-targeted
  cross-org policy this mirrors); [ADR-0028](0028-auth-refresh-token-store.md) (the refresh-token store +
  its "rejected: a cross-org sweeper role" alternative this ADR now adopts for the churned-org gap);
  [ADR-0033](0033-session-exchange.md) (the session-exchange store); the on-access opportunistic sweep
  (PR for `sweepExpiredRefreshTokens`/`sweepExpiredSessionExchanges`).
- review severity: high (a new cross-org, control-plane DB role + a scheduled mutation across every tenant).

## context

The two short-lived auth-handle tables — `auth_refresh_token` (0017, ~90d) and `auth_session_exchange`
(0019, ~5m) — accumulate **expired** rows. Expiry is already ENFORCED at consume (`expires_at > now()` in the
consume gate), so a lingering expired row is never honored; it's dead weight, not a correctness risk.

The on-access opportunistic sweep already prunes the **consuming** org's expired rows after each consume,
running under `withTenant` as `webhook_app` (the table's existing org-scoped DELETE policy). Its documented
limitation: an org that **never consumes again** (a churned / abandoned org) never gets swept, so its handful
of dead rows linger forever. ADR-0028 explicitly listed a dedicated cross-org sweeper role as a *rejected
alternative at the time* (deferred, not wrong). This ADR adopts it to close exactly that gap.

Both tables are `FORCE ROW LEVEL SECURITY`, so a `SECURITY DEFINER` function is a non-starter: it runs **as the
table owner**, which FORCE RLS keeps subject to policies — it would see zero rows and prune nothing. The
schema also ships **zero** `SECURITY DEFINER` routines by policy (a catalog test asserts it), and `BYPASSRLS`
/`SUPERUSER` are forbidden on every job path here.

## decision

**A daily cron deletes expired rows across all orgs as a new, least-privilege `webhook_sweeper` role gated by
a role-targeted permissive DELETE policy.**

- **The role-targeted DELETE policy, not SECURITY DEFINER.** Each table gets a
  `for delete to webhook_sweeper using (expires_at < now())` policy (migration 0020), mirroring the
  `webhook_anchor` cross-org SELECT precedent (migration 0010). Permissive policies OR together, but this one
  is scoped TO `webhook_sweeper`, so it never widens what `webhook_app` sees — `webhook_app`'s own DELETE
  policy stays org-scoped. This is the RLS-native way to grant one role a cross-org DELETE **without** bypassing
  RLS, which FORCE RLS would defeat for any owner/definer bypass anyway.
- **DELETE-only, no read.** `webhook_sweeper` holds `DELETE` (and only DELETE) on the two tables — no
  SELECT/INSERT/UPDATE. It cannot read any handle row (the hashes, the org/grant/user linkage, the
  timestamps); it can only delete. A leaked credential can, at worst, delete already-expired (already-unusable)
  rows across tenants — it cannot read, mint, forge, or alter a live session.
- **Bare deletes, the policy is the only filter.** `pruneAllExpiredAuthTokens` issues `delete from
  auth_refresh_token` / `delete from auth_session_exchange` with **no** `where expires_at < now()` clause — we
  rely on the policy's `USING` so the role needs zero SELECT privilege. A btree index on `expires_at` (added by
  0020) keeps the delete index-driven as the tables grow.
- **Daily cron at 04:00 UTC.** A `scheduled()` handler on the `auth.` Worker connects as `webhook_sweeper` over
  its own cache-disabled `HYPERDRIVE_SWEEPER` binding, prunes, logs a single structured count line
  (`auth.sweep.cron` — counts only, no PII), and always closes the pool. It's non-throwing: any failure logs
  `auth.sweep.cron.error` (message only) and is swallowed so a cron error never surfaces as an uncaught
  rejection. The on-access sweep covers active orgs; this covers the churned/abandoned ones — once a day is
  ample for dead-row housekeeping.
- **No-secrets provisioning.** The role is created password-less in the migration (login-disabled until ops
  sets a password out of band, exactly like every other non-owner role). The operator provisions the Neon role
  + password and a CF Hyperdrive bound to it, then sets the `HYPERDRIVE_SWEEPER_ID` GH repo var; the deploy
  overlay (`gen-wrangler-prod.mjs`) injects the real id. No id/secret is committed.

## consequences

- The churned-org gap from ADR-0028 / the on-access sweep is closed: every expired handle is eventually pruned,
  whether or not its org ever consumes again.
- A new cross-org DB role exists. It is the second role-targeted-policy role (after `webhook_anchor`) and the
  catalog/RLS tests assert its posture: non-owner, non-superuser, no BYPASSRLS, owns no tables, and holds
  DELETE — and only DELETE — on the two token tables and nothing else.
- The cron is best-effort housekeeping, never load-bearing: consume-time expiry enforcement remains the
  correctness guarantee. A skipped or failed sweep degrades only to "dead rows linger a little longer."
- The schema keeps its zero-`SECURITY DEFINER` invariant; the cross-org capability is expressed entirely as a
  scoped, least-privilege role + a role-targeted policy.
