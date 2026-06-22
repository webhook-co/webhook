# ADR 0039 — CLI profiles: `--profile`/`WBHK_PROFILE` resolution + config v2 migration

- status: accepted (**D3a** — the profile-resolution + config-versioning mechanics; the `profile
  use|list|current|add|remove` command family + the per-command active-profile banner land in D3b).
- date: 2026-06-22
- scope: `packages/cli/src/config/schema.ts` (`CONFIG_VERSION` 1→2, `activeProfile`, `migrateConfigShape`),
  `packages/cli/src/config/file-store.ts` (read-version-first migrate on load + `getActiveProfile`),
  `packages/cli/src/config/env-store.ts` + `config/store.ts` (`getActiveProfile` on the backend + the
  resolved store), `packages/cli/src/global-flags.ts` (`--profile` flag + `WBHK_PROFILE` + the async
  `resolveProfile` + the reserved-name guard), `packages/cli/src/errors.ts` (`InvalidProfileNameError`),
  `packages/cli/src/commands/{shared,login,whoami,listen,replay}.ts` (thread the resolved profile). Tests
  across those plus `endpoints.test.ts` (an end-to-end `--profile` header-capture).
- relates: ADR-0009 (CLI foundation), ADR-0037 (D2a global-flag spec this extends). The CONFIG_VERSION
  ladder is shared with D8 (the OAuth credential union bumps it next). `internal/build-plans/lane-d-cli.md`
  §D3. Lane D (`packages/cli`).
- review severity: medium (changes credential resolution for every command + the on-disk config shape).
  One fresh-eyes code review (SHIP) + one security red-team (SHIP) — the red-team's reserved-profile-name
  footgun (a `__proto__` write silently no-ops while reporting success) was folded in as a guard.

## context

The on-disk config was already profile-keyed and versioned (v1: `{version, profiles}`), and the store's
methods all took a profile argument — but nothing selected a profile: every command called `store.get()`
with no argument, so it always read `DEFAULT_PROFILE`. A user juggling multiple orgs/environments had no
way to say "run this against staging". This slice adds the selection layer (and the config groundwork the
persisted default + D8's credential union need), deliberately split from the `profile` management commands
+ banner (D3b) to keep the PR reviewable.

A constraint shaped the design: `buildContext` runs **before** argv is parsed (ADR-0037), so a flag value
can't be resolved there; and the persisted-active-profile fallback is an async store read, so it can't
live in the sync `resolveGlobals`. Hence a dedicated async resolver, called per-handler.

## decision

1. **Config v2 + a read-version-first migration ladder.** `CONFIG_VERSION` → 2, with a new optional
   `activeProfile`. `migrateConfigShape(raw)` reads the on-disk `version` FIRST and upgrades prior versions
   to the current shape BEFORE zod validation (v1→v2 is a pure version bump; the profile map carries over).
   Each step is vN→vN+1, never always-from-v1. An unknown/future version is left untouched → the
   `z.literal(2)` schema rejects it as `CorruptConfig` — the safe fail-closed stance for a config a newer
   CLI wrote. The migration is pure; the on-disk upgrade is **lazy** (written back only on the next
   credential/config write), so a read never mutates disk. The 0600 permission gate still runs before the
   parse.

2. **`resolveProfile(ctx, flags)` — `--profile` › `WBHK_PROFILE` › persisted `activeProfile` › `default`.**
   An async resolver (the persisted fallback is a store read). An empty `--profile`/env value is treated as
   unset. `authedClient` calls it internally, so the read commands (endpoints/events/audit) need no change;
   `login`/`whoami`/`listen`/`replay` resolve it once and thread the same profile into every store call
   (read AND write under one profile — no confused-deputy). The env backend's credential
   (`WBHK_API_KEY`) deliberately remains a profile-agnostic global override (the CI/headless escape hatch),
   so it has no active profile (`getActiveProfile` → undefined).

3. **`getActiveProfile` — required on the backend, optional on the resolved store.** `CredentialBackend`
   gains a required `getActiveProfile()` (file reads `activeProfile`; env returns undefined); the resolved
   `CredentialStore` exposes it as an OPTIONAL method (so the many inline in-memory test fakes need not
   implement it — absent → resolves to the default profile). `resolveStore` returns the first backend's
   value.

4. **Reserved profile names are refused.** Profiles key an in-memory object map, so `__proto__` (a
   bracket-write hits the prototype, not an own key → a `login` silently persists nothing while reporting
   success) and `constructor`/`prototype` (shadowing) are rejected with `InvalidProfileNameError` (USAGE)
   from the single `resolveProfile` choke point — covering the flag, env, and persisted sources at once.

## consequences

- `wbhk --profile staging events list` (or `WBHK_PROFILE=staging`) reads staging's stored credential +
  sticky base URL; `--profile staging login` writes them under staging. No behaviour change for a user who
  passes nothing (resolves to `default`, exactly as before).
- A pre-existing v1 config upgrades losslessly on the next write; a corrupt or newer-version config fails
  closed (`CorruptConfig`), never a silent misparse.
- The persisted-`activeProfile` READ path is complete here; the WRITE (`profile use`) + the management
  commands + the active-profile banner are D3b — purely additive on this foundation.

## alternatives considered

- **Fold profile resolution into the sync `resolveGlobals`.** Rejected — the persisted fallback is an
  async store read; a sync resolver can't await it. A dedicated async `resolveProfile` is the seam.
- **Resolve the profile in `buildContext` and bind a profile-scoped store.** Rejected — the context is
  built before argv is parsed, so it can never see `--profile`. Resolution must be per-handler.
- **Thread `profile` through every command explicitly.** Done only for the direct-store commands;
  `authedClient` resolves internally so the three read commands stay untouched (less churn, one seam).
- **Per-profile config files (`config-<profile>.json`).** Rejected — a single profile-keyed file is the
  existing model; per-file would invite a profile name flowing into a filesystem path (traversal surface)
  for no benefit.
- **`Object.create(null)` / a `Map` for the profiles map instead of a reserved-name guard.** Rejected for
  now — it would ripple through the zod `z.record` shape + JSON round-trip; the explicit name guard is a
  smaller, clearer fix that also yields a good error message.
