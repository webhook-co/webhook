# ADR 0067 — `wbhk upgrade` self-update (distribution DIST-13)

- status: accepted (distribution Phase 5 — self-update).
- date: 2026-06-24
- scope: new `packages/cli/src/commands/upgrade.ts` (+ `upgrade.helpers.test.ts`, `upgrade.test.ts`); a
  `replaceExecutable` io seam (`context.ts` + `io.ts`); `arch` + `execPath` on the context; registered in
  `app.ts`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-13). ADR-0062 (version stamping), ADR-0064/0065
  (the release pipeline + binaries this updates from), ADR-0066 (npm — a managed install upgrade path).
- review severity: medium (downloads + replaces the running binary). `/code-review` + `/security-review`.

## context

`wbhk` installs as a standalone binary (`curl | sh`, ADR-0065) or via a package manager (npm/Homebrew/Scoop).
A binary install has no updater, so it goes stale. `wbhk upgrade` self-updates a binary install and points a
managed install at its own updater.

## decision

1. **Pure decision, impure execution.** All the logic — asset selection per OS/arch, install-source
   detection, version comparison, release selection, and the fail-closed checksum verify — is pure +
   unit-tested (`upgrade.helpers.test.ts`, 28 cases). The command handler does the I/O (GitHub fetch +
   binary replace) through injected seams and is tested end-to-end with a fake fetch + a recording replace
   (`upgrade.test.ts`, 10 cases). Mirrors `doctor`'s "pure checks + impure handler" shape.

2. **Source-aware.** `detectInstallKind(execPath)` classifies the install: a node/bun runtime execPath → the
   npm/dev install; a Cellar / Scoop path → that manager; otherwise a standalone binary. Managed installs
   get the right "upgrade with `npm i -g wbhk@latest` / `brew upgrade wbhk` / `scoop update wbhk`" hint and
   are **never** self-replaced (their manager owns the file). Only a standalone binary self-updates.

3. **Fail-closed integrity, then atomic replace.** For a binary install: fetch `/releases`, pick the newest
   non-draft, non-prerelease `cli-v*` (scans the list — `/releases/latest` is repo-wide and could be a
   non-CLI release), download the OS/arch asset + `checksums.txt`, **verify the sha256 — requiring the
   asset's line to exist before comparing (the same fail-closed guarantee as install.sh, ADR-0065) — and
   only then** replace. The replace (io.ts, coverage-excluded) writes the bytes to a temp file in the
   target's own directory, `chmod +x`, and renames over the target (atomic on POSIX; rename-aside-first on
   Windows, where a running `.exe` can't be overwritten in place), then clears the macOS quarantine flag.

4. **`--check` and structured output.** `wbhk upgrade --check` reports whether an update exists without
   touching the binary; `--output json` emits `{ action, currentVersion, latestVersion, updateAvailable, … }`
   for scripting. A failed replace (e.g. no write permission) surfaces as a clean error pointing at perms /
   the package-manager path, not a stack trace.

## consequences

- Binary-install users get a one-command, checksum-verified, atomic self-update; managed users get correct
  guidance. `arch` + `execPath` are now on the context (mirroring `platform`), so asset selection + the
  replace target are testable.
- **Human-verification flag (engineering guardrail):** the *logic* is fully unit-tested, but the real
  in-place self-replace (`io.ts`'s `replaceExecutable`) can only be exercised end-to-end **once a public
  release exists** — there is nothing to upgrade to yet. So the real download→verify→replace→still-runs path
  must be human-verified after the first `cli-v*` release is published (on macOS/Linux, and ideally Windows).
  Until then it is unit-verified through the injected seam only.
- Unsigned-binary note: the replace clears the macOS quarantine flag (signing is a later phase, ADR-0065);
  integrity rests on the sha256 gate until sigstore (DIST-7) lets `upgrade` also verify a signature.

## alternatives considered

- **Replace via a child "updater" process** (to swap a binary that can't replace itself). Rejected for
  POSIX (rename-over-running works) + Windows (rename-aside works); a helper process is only needed for
  edge cases we don't have.
- **Trust `/releases/latest`.** Rejected — it's the repo-wide latest and could be a non-CLI release in this
  monorepo; scanning for the newest `cli-v*` is correct.
- **Self-update managed installs too.** Rejected — overwriting a package-manager-owned file fights the
  manager; deferring to it is correct.
