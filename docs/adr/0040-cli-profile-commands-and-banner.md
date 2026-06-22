# ADR 0040 — CLI `profile` command family + active-profile banner

- status: accepted (**D3b** — the profile-management UX on top of D3a's resolution mechanics; completes
  the D3 profiles slice. `profile add` is intentionally NOT shipped — see alternatives).
- date: 2026-06-22
- scope: `packages/cli/src/commands/profile.ts` (new — `use`/`current`/`list`/`remove` + the route),
  `packages/cli/src/app.ts` (register `profile`), `packages/cli/src/config/{store,file-store,env-store}.ts`
  (`setActiveProfile` write method), `packages/cli/src/global-flags.ts` (`resolveActiveProfile` shared
  resolver + `isReservedProfileName` + `announceActiveProfile` banner), `packages/cli/src/commands/{shared,
  login,whoami,listen,replay}.ts` (emit the banner). Tests: `commands/profile.test.ts` (new) +
  `config/{store,file-store}.test.ts` + `commands/endpoints.test.ts` (banner).
- relates: ADR-0039 (D3a — profile resolution + config v2, which this builds on), ADR-0009 (CLI
  foundation). `internal/build-plans/lane-d-cli.md` §D3. Lane D (`packages/cli`).
- review severity: medium (a new command family + a cross-cutting per-command banner). One fresh-eyes code
  review (SHIP) + one security red-team (SHIP) — the code review's `list`-vs-`current` "active" mismatch
  (MINOR) + the precedence-duplication (NIT) were folded by extracting one shared resolver.

## context

D3a shipped profile *selection* (`--profile`/`WBHK_PROFILE`/persisted/default) but no way to manage
profiles: a user couldn't set the persisted default, see which profiles exist, or remove one. D3b adds the
management commands + a safety banner, completing the profiles feature.

## decision

1. **`setActiveProfile(name | undefined)` write plumbing.** Required on `CredentialBackend` (the file
   backend writes/clears `config.activeProfile`; the read-only env backend throws
   `BackendNotWritableError`); optional on the resolved `CredentialStore` (so the inline in-memory test
   fakes need not implement it, mirroring `getActiveProfile`). `resolveStore` persists to the first
   writable backend (else `SecureStorageRequiredError`) — the same policy as `setApiBaseUrl` (the active
   profile is config, not a secret). The write rides the existing `write()` helper, so the 0600/0700
   permission re-tightening is preserved.

2. **`wbhk profile use|current|list|remove`.**
   - `use <name>` persists the active profile; a stderr heads-up when that profile holds no credential yet
     (the switch is still valid). Rejects reserved names.
   - `current` prints the effective profile + its source (`--profile`/`WBHK_PROFILE`/`active profile`/
     `default`); read-only, so it shows (not rejects) a reserved name.
   - `list` shows every profile, marking the **effective** active with `*`; `--output json` →
     `{ profiles, active }`.
   - `remove <name>` erases the profile's credential (USAGE error if it doesn't exist) and, if it was the
     persisted active profile, clears the pointer so resolution falls back to `default`. Rejects reserved
     names.

3. **One shared `resolveActiveProfile(ctx, flags) → { name, source }`.** The single source of truth for
   the precedence, used by `resolveProfile` (which then applies the reserved-name guard), `profile
   current`, and `profile list` — so `list`'s `*` marker and `current` can never disagree (both reflect
   `WBHK_PROFILE`/`--profile`, not just the persisted pointer). The resolver itself is display-safe
   (non-throwing); only the command-path `resolveProfile` throws on a reserved name.

4. **Active-profile banner.** `announceActiveProfile` writes a one-line `using profile: <name>` to
   **stderr** when the resolved profile isn't the default — so running against staging/prod never
   surprises. Off stdout (pipes stay clean), silent for the default (the common case), name sanitized, and
   fired exactly once per command (inside `authedClient` for the read commands; once each in
   login/whoami/listen/replay). The `profile` family itself never emits it.

## consequences

- `wbhk profile use staging` makes staging the persisted default; `wbhk profile list` shows it marked;
  `wbhk profile remove staging` deletes it and reverts the default. A non-default profile is announced on
  stderr on every command, a guardrail against acting on the wrong environment.
- The active-profile concept now has a complete read+write surface; `getActiveProfile` (D3a) + this
  `setActiveProfile` round-trip through the 0600 config.
- `profile current` and `profile list` agree on "active" by construction (one resolver).

## alternatives considered

- **Ship `profile add`.** Deferred — a profile is created implicitly by `login --profile <name>` (which
  writes a credential) or by setting its base URL; an explicit `add` would create an empty entry that
  holds nothing, and would need a create-empty-profile backend method for marginal value. Named here, not
  silently dropped — revisit if a "pre-register an empty profile" need emerges.
- **`list` marks the persisted pointer only.** Rejected — it would disagree with `current` in the same
  shell when `WBHK_PROFILE`/`--profile` is set. Both now read `resolveActiveProfile`.
- **Emit the banner from `resolveProfile`.** Rejected — `resolveProfile` is a pure resolver called in
  contexts where a banner is unwanted (tests, the `profile` commands). The banner is a separate, explicit
  call at the command seam.
- **`setActiveProfile` as two methods (set + clear).** Rejected — a single `name | undefined` is smaller;
  `undefined` clears (deletes the field), which `remove` needs.
