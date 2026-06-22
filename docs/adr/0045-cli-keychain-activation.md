# ADR 0045 — `wbhk` OS-keychain activation (the shell-out seam + wiring)

- status: accepted (**D7b** — activates the D7a keychain machinery: wires it into the live context, adds
  the OS shell-out, and the `login --insecure-storage` opt-in). Completes D7.
- date: 2026-06-22
- scope: `packages/cli/src/context.ts` (`IoSeams.keychain`; `buildContext` composes `[env, keychain,
  file]`; `makeTestContext` defaults the keychain to "unavailable"), `packages/cli/src/io.ts`
  (`makeRealKeychainIo` + `runKeychainCli`, coverage-excluded), `packages/cli/src/config/store.ts`
  (`resolveStore.get` tolerates `KeychainUnavailableError`), `packages/cli/src/commands/login.ts`
  (`--insecure-storage`). Tests across `context`/`login`/`store`.
- relates: ADR-0044 (the composition machinery this activates), ADR-0009 (the shell-out-over-NAPI
  keychain decision). `internal/build-plans/lane-d-cli.md` §D7. Lane D (`packages/cli`).
- review severity: high (live credential storage + an OS shell-out). One AUTH red-team + one code review —
  both SHIP; the code review's EPIPE-on-stdin defect was folded.

## context

D7a shipped the dormant keychain backend + the store composition that keeps secrets in the keychain and
config in the file, degrades on a missing keychain, and fails loud under `requireSecureStorage`. D7b makes
it live: the real OS calls, the context wiring, and the user-facing opt-out.

## decision

1. **`buildContext` composes `[env, keychain, file]`.** `io` is resolved first so the credential store can
   build the keychain backend over `io.keychain`. Read precedence: env (CI override) › keychain (secure) ›
   file (insecure fallback); credential writes prefer the keychain, config writes go to the file (ADR-0044).

2. **`makeRealKeychainIo` — `spawn`, never a shell.** macOS `security` (find/add `-U`/delete-generic-password,
   `-s <service> -a <profile>`), Linux `secret-tool` (lookup / store-via-**stdin** / clear); Windows and
   anything else report unavailable (no CLI that reads a secret back) → fall back to the 0600 file. `spawn`
   takes an args ARRAY (no shell, and `security`/getopt binds a leading-dash profile to its `-a` slot
   rather than treating it as a flag — empirically verified — so a profile name can't inject). stderr is
   discarded so a keychain prompt/error can't carry the secret out. macOS exit 44 (errSecItemNotFound) →
   null on read / no-op on erase; the `-w` trailing newline is stripped.
   - **Known limitation (documented, accepted):** macOS `add-generic-password -w <secret>` puts the secret
     in argv (briefly visible to `ps` during the write) — inherent to that CLI; `secret-tool` takes the
     secret on stdin (no exposure). The encryption-at-rest benefit holds either way; NAPI (leak-free) is a
     drop-in behind the seam if it ever embeds under `bun --compile` (ADR-0009).

3. **`resolveStore.get` tolerates a missing keychain.** Only `KeychainUnavailableError` (mapped from
   `spawn` ENOENT) is skipped on read — a present-but-failing keychain returns a non-zero exit → a generic
   error that propagates (no auth-bypass / silent skip of a keychain that actually holds the credential).

4. **`login --insecure-storage`** passes `{ allowInsecure: true }` to `store.set`, the sole explicit escape
   that lets the credential land in the file under `requireSecureStorage` (the gh model).

5. **Tests never touch the real keychain.** `makeTestContext` (and `context.test`'s `fakeIo`) default the
   keychain to "unavailable", reproducing the pre-keychain file-fallback for every existing test; a test
   that exercises the keychain injects its own in-memory fake.

## consequences

- `wbhk login` stores the `whk_` key in the OS keychain (encrypted at rest) by default; a box without a
  keychain helper falls back to the 0600 file (or, under require-secure, fails loud pointing at
  `--insecure-storage`). `logout` clears both (ADR-0044's best-effort erase).
- The macOS command shapes + exit codes are backend-verified against a throwaway temp keychain
  (set/update/get round-trip; not-found → 44). The **Linux `secret-tool` path is unverified here** (no
  libsecret on the build box) — flagged for a real-Linux smoke; it's standard libsecret usage and the
  no-shell/positional-arg safety holds.

## alternatives considered

- **Probe keychain availability at startup.** Rejected — async OS probe vs a sync `buildContext`; lazy
  `KeychainUnavailableError` + the fallback loop (ADR-0044) handles it without a startup cost.
- **A profile-name charset allow-list for argv safety.** Deferred (red-team NIT) — the no-shell + positional
  `-a` binding already makes injection impossible; an allow-list would be robust-by-construction
  defense-in-depth, a small follow-up.
- **Support Windows via `cmdkey`.** Rejected — `cmdkey` can't read a secret back; Windows falls back to the
  file until a PowerShell/Credential-Manager seam is added.
