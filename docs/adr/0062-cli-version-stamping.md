# ADR 0062 — CLI version stamping (build-time `--define`) (DIST-1)

- status: accepted (distribution Phase 1, DIST-1 — the first slice of the CLI distribution epic).
- date: 2026-06-24
- scope: `packages/cli/src/version.ts` (`resolveVersion` + build-time `WBHK_VERSION` define) + tests;
  `packages/cli/scripts/bundle.mjs` (conditional `--define` from `WBHK_BUILD_VERSION`).
- relates: `internal/build-plans/cli-distribution.md` (DIST-1; the release workflow DIST-3 sets
  `WBHK_BUILD_VERSION` from the `cli-vX.Y.Z` tag). ADR-0041 (doctor reports the version; the `(dev)` suffix).
- review severity: low (build-time constant injection; no runtime/auth surface). `/code-review`.

## context

`VERSION` was hardcoded `"0.0.0"` (→ `doctor` shows `0.0.0 (dev)`); the distribution epic needs the binary
+ npm package + `--version` + `doctor` to report the REAL release version. Bun's `--compile` supports
build-time constants via `--define` (zero runtime cost, dead-code-eliminated), which is the clean way to
stamp a standalone binary without a generated-file or a git call at runtime.

## decision

1. **The version is a build-time define.** `version.ts` declares `WBHK_VERSION` (a `string | undefined` the
   bundler replaces) and computes `VERSION = resolveVersion(typeof WBHK_VERSION === "string" ? WBHK_VERSION
   : undefined)`. The `typeof` guard means a plain `tsc`/`node`/test run (no define) sees `undefined` →
   `resolveVersion` returns `"0.0.0"` (the dev placeholder) with no `ReferenceError`. `resolveVersion` is a
   pure, unit-tested helper (`"" `/undefined → `0.0.0`; a real value passes through).

2. **`bundle.mjs` stamps from `WBHK_BUILD_VERSION`.** When that env var is set (the release pipeline derives
   it from the `cli-vX.Y.Z` tag), the bundle adds `--define WBHK_VERSION=<JSON.stringify(version)>` (the
   quoted JS string literal bun expects). A local dev bundle leaves it unset → the binary reports
   `0.0.0 (dev)`. Verified empirically: `WBHK_BUILD_VERSION=0.3.0-test … bundle` → `wbhk --version` =
   `0.3.0-test`, `doctor` → `✓ cli: wbhk 0.3.0-test`.

3. **No change to consumers.** `--version` (stricli `versionInfo.currentVersion`) and `doctor` already read
   `VERSION`; doctor's `=== "0.0.0" ? "(dev)"` logic is unchanged — a stamped build is non-`0.0.0`, so the
   `(dev)` suffix drops automatically.

## consequences

- A released binary/npm package reports its real version; a dev build stays `0.0.0 (dev)` — no ambiguity.
- No new dependency, no runtime cost (the define is inlined + dead-code-eliminated), no git/file read at
  runtime. The version source is the release tag (single source of truth), wired in DIST-3.

## alternatives considered

- **Read `package.json` at runtime.** Rejected — a standalone binary has no `package.json` on disk; bundling
  + reading it is fragile vs a compile-time constant.
- **Generate `version.ts` from the tag at build.** Rejected — a generated source file is messier than a
  `--define` (which is exactly Bun's intended mechanism) and would dirty the tree.
- **Stamp from git describe at build.** Deferred — the release tag is the authoritative version; a git call
  is an extra dependency. (DIST-3 may pass `git describe` as `WBHK_BUILD_VERSION` for nightly/edge builds.)
