# ADR 0044 — CLI credential-store composition for an OS keychain

- status: accepted (**D7a** — the composition machinery + a dormant keychain backend. Wiring it into the
  live context, the OS shell-out seam in io.ts, and the `login --insecure-storage` flag land in **D7b**).
- date: 2026-06-22
- scope: `packages/cli/src/config/store.ts` (`persistsConfig` on `CredentialBackend`; config-write
  routing; the fallback-aware `set` + `SetCredentialOptions.allowInsecure`; erase tolerates a missing
  keychain), `config/keychain-store.ts` (new — `createKeychainBackend` over a `KeychainIo` seam),
  `config/errors.ts` (`KeychainUnavailableError`), `config/{env,file}-store.ts` (`persistsConfig`).
- relates: ADR-0009 (the credential-backend foundation + the shell-out-over-NAPI keychain decision),
  ADR-0039/0040 (the profile config this routing keeps in the file). `internal/build-plans/lane-d-cli.md`
  §D7. Lane D (`packages/cli`).
- review severity: high (credential-storage security). One AUTH red-team + one code review — both SHIP; the
  red-team's MINOR (erase didn't tolerate a missing keychain → a stale credential on logout) was folded.

## context

Credentials live in a 0600 file (insecure-but-private). The plan calls for an OS-keychain backend
(encrypted at rest) composed AHEAD of the file. Two problems had to be solved in the COMPOSITION before
the OS plumbing (D7b): (1) a keychain ahead of the file would, under the old "first writable backend"
rule, swallow non-secret CONFIG (the active profile + base URLs); (2) a missing OS keychain needs to
degrade safely — fall back to the file by default, but fail LOUD under `requireSecureStorage`. This slice
is the machinery + the backend, kept DORMANT (not wired into `buildContext`) so it ships no behaviour
change and can be reviewed in isolation.

## decision

1. **`persistsConfig` separates secrets from config.** A new `CredentialBackend.persistsConfig` flag
   (keychain `false`, file `true`, env `false`) routes `setActiveProfile`/`setApiBaseUrl` to the first
   `canWrite && persistsConfig` backend — so a keychain composed ahead of the file never swallows the
   non-secret config (it stays in the file). Credential `set` still routes by `secure`/`canWrite`. This
   is behaviour-identical for the current `[env, file]` composition (env is read-only anyway).

2. **`set` degrades safely; only a missing keychain falls through.** Under `requireSecureStorage` (and no
   `allowInsecure`), only `secure` backends are eligible — the file is filtered out, so a credential can
   never silently land insecurely. The write tries candidates in order; ONLY a `KeychainUnavailableError`
   (no OS keychain installed) falls through to the next candidate — so the default policy degrades
   keychain→file, while require-secure has nothing to fall through to and fails loud
   (`KeychainUnavailableError`, message points at `--insecure-storage`). Any OTHER failure (denied,
   locked, write error) propagates — never a silent insecure downgrade. `SetCredentialOptions.allowInsecure`
   (the `--insecure-storage` opt-in, wired in D7b) is the sole explicit escape.

3. **`erase` is best-effort across backends.** Logout clears the credential from every writable backend; a
   missing keychain (`KeychainUnavailableError`) is swallowed so the file still gets wiped — no stale
   secret left behind. Any other erase error propagates.

4. **The keychain backend is thin over a seam.** `createKeychainBackend({ keychainIo })` is `secure: true,
   canWrite: true, persistsConfig: false`; it maps profile→account and credential↔secret over an injected
   `KeychainIo` (get/set/erase). The real OS shell-outs (macOS `security` / Linux `secret-tool` / Windows
   credential CLIs) live in io.ts (D7b, coverage-excluded); this backend is unit-tested with a faked seam
   (an in-memory map + an always-unavailable variant).

## consequences

- D7b can compose `[env, keychain, file]` and the credential goes to the keychain (encrypted at rest) by
  default, config stays in the file, and a no-keychain box degrades to the file (or fails loud under
  require-secure) — all driven by this machinery.
- No behaviour ships in D7a (dormant); the existing `[env, file]` store is byte-for-byte equivalent.
- The require-secure guarantee is airtight: a credential reaches the file only via the explicit
  `allowInsecure` opt-in.

## alternatives considered

- **Keychain stores config too (base URL + active profile).** Rejected — that puts non-secret config in
  the keychain (more shell-outs, odd) and couples config to keychain availability; `persistsConfig` keeps
  the clean split.
- **Detect keychain availability at construction (`canWrite`).** Rejected — availability is an async OS
  probe and `buildContext` is sync; lazy `KeychainUnavailableError` + the fallback loop handles it without
  a startup probe.
- **NAPI (`@napi-rs/keyring`) instead of shell-out.** Rejected per ADR-0009 — it won't embed under
  `bun --compile`; the shell-out seam is the portable default (D7b). The seam keeps NAPI a drop-in later.
- **Silently fall back to the file on any keychain error.** Rejected — only "no keychain installed" falls
  back; a denied/locked keychain must not silently write the secret to the insecure file.
