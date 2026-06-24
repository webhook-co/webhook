# ADR 0065 — multi-platform binaries + `install.sh` (distribution DIST-4 + DIST-5)

- status: accepted (distribution Phase 2 — binaries everywhere).
- date: 2026-06-24
- scope: new `packages/cli/scripts/release-build.mjs` (cross-compile matrix) + `packages/cli/scripts/install.sh`
  (the `curl | sh` installer); `.github/workflows/release-cli.yml` (build all platforms, upload all assets).
- relates: `internal/build-plans/cli-distribution.md` (DIST-4, DIST-5; DIST-5b = the `get.webhook.co` Worker
  that serves install.sh; DIST-6 npm; DIST-8/9 signing). ADR-0062 (version stamping), ADR-0064 (the release
  workflow this extends).
- review severity: medium (release artifacts + an `curl | sh` installer that runs on users' machines).
  `/code-review` + `/security-review`.

## context

DIST-3 shipped the release workflow as a single-platform (linux-x64) draft. Phase 2 makes it real: build a
binary for every supported OS/arch and give users a one-line install. Bun cross-compiles all targets from a
single host (de-risked in the plan + re-proven here building all 5 locally), so no per-OS CI matrix is needed.

## decision

1. **`release-build.mjs` cross-compiles all targets from one runner.** `bun build --compile --target=<t>`
   per target → `packages/cli/out/wbhk-<os>-<arch>[.exe]`, stamped with `WBHK_BUILD_VERSION` (ADR-0062),
   then a `checksums.txt` (sha256, `sha256sum -c` format). Targets: darwin arm64/x64, linux x64/arm64,
   windows x64. **x64 uses the `-baseline` Bun targets** (its AVX2 SIMD would `Illegal instruction` on
   pre-2013 CPUs; baseline is the safe default for a distributed binary; arm64 has no baseline). The asset
   names drop the `-baseline` detail (users don't care). Same tsconfig-aside dance as bundle.mjs (so bun
   resolves workspace deps to source); a stray `--sourcemap` byproduct is pruned so only `wbhk-*` +
   `checksums.txt` ship. Verified locally: all 5 build, correct ELF/PE32+/Mach-O, checksums verify, the
   native one reports the stamped version. (Windows `.exe` metadata can't be set when cross-compiling — a
   later refinement on a Windows runner if wanted; not needed for a console CLI.)

2. **The workflow builds all platforms + uploads all assets to the DRAFT release.** `release-cli.yml` runs
   `release-build.mjs` (still draft-only; still asserts the linux-x64 binary's `--version` == the tag).

3. **`install.sh` — `curl -fsSL https://get.webhook.co | sh`.** POSIX sh (verified on sh + dash). Detects
   OS (`uname -s`) + arch (`uname -m` → x64/arm64), downloads the matching asset + `checksums.txt` from the
   **latest published** release (or `WBHK_VERSION`-pinned `cli-v<ver>`), **verifies the sha256 and refuses
   to install** — failing CLOSED not only on a hash mismatch but also when the asset has **no entry** in
   `checksums.txt` (the line is captured and asserted non-empty *before* the checker runs; piping `grep`
   straight into `sha256sum -c` would be unsafe — POSIX sh has no `pipefail` and some `sha256sum` builds
   exit 0 on empty stdin). Then installs to `$WBHK_INSTALL_DIR` (default `~/.local/bin`), `chmod +x`, clears the
   **macOS quarantine** flag (so Gatekeeper doesn't block the unsigned binary until signing lands), and warns
   if the dir isn't on `PATH`. Windows → use Scoop / the `.exe` (Phase 5 / releases page). Fails cleanly with
   an actionable message when no published release exists yet (verified).

## consequences

- A tagged release now produces signed-checksums binaries for every platform on a draft Release; a user
  installs with one line (once the founder publishes the first release). The installer never installs an
  unverified binary.
- Single-runner CI (no per-OS matrix) — simpler + cheaper.
- Still draft-only + unsigned: the first PUBLIC release is the founder's call (DIST-3), and signing/
  notarization is Phase 4 (the quarantine-clear + checksum verification bridge the gap until then).
- `release-build.mjs` duplicates ~12 lines of bundle.mjs's tsconfig-aside dance — accepted (two
  self-contained build scripts; extract a shared helper later if a third appears).

## alternatives considered

- **A per-OS GitHub Actions matrix (native runners).** Rejected — Bun cross-compiles from one host, so a
  matrix adds cost + coordination for no benefit. (Fallback documented in the plan if a target ever can't
  cross-compile.)
- **`-modern`/default x64 targets.** Rejected for the shipped binary — `-baseline` avoids `Illegal
  instruction` on older CPUs; the perf delta is negligible for a CLI.
- **Re-host binaries off GitHub.** Rejected — GitHub Releases is the free CDN + provenance home; install.sh
  + the get.webhook.co Worker (DIST-5b) just redirect to it.
