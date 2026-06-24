# ADR 0064 — CLI release workflow skeleton (tag → draft binary) (DIST-3)

- status: accepted (distribution Phase 1, DIST-3 — the release pipeline's first cut).
- date: 2026-06-24
- scope: new `.github/workflows/release-cli.yml`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-3; DIST-4 adds the cross-compile matrix, DIST-6
  npm publish, DIST-8/9 signing). ADR-0062 (version stamping — this drives `WBHK_BUILD_VERSION` from the tag).
- review severity: medium (release infra; `contents: write`). `/code-review` + `/security-review` (infra lens).

## context

The CLI builds locally (`scripts/bundle.mjs`) but nothing publishes it. DIST-3 stands up the release
pipeline end-to-end on ONE platform — proving tag → stamped build → checksummed artifact → GitHub Release —
before the later phases add the multi-platform matrix, npm, package managers, and signing. The org restricts
GitHub Actions to GitHub-owned publishers, so (like ci.yml + the deploy CDs) the workflow calls tooling
directly: the official bun installer + the `gh` CLI, no marketplace actions.

## decision

1. **Trigger: a `cli-vX.Y.Z` tag** (push), plus `workflow_dispatch` (a `version` input) for testing. The
   version is derived from the tag (`${tag#cli-v}`), validated as semver-ish, and passed as
   `WBHK_BUILD_VERSION` to the bundle so the binary self-reports it (ADR-0062). The tag is the single source
   of truth for the version.

2. **Always a DRAFT release.** The workflow creates a *draft* GitHub Release (or `--clobber`-uploads to an
   existing one) — never public until a human reviews + publishes it. So pushing a tag / dispatching is safe
   to test, and the first PUBLIC release stays a deliberate human action (matching the distribution plan's
   gate). Merging this workflow file is inert — nothing runs until a tag is pushed.

3. **Single platform for the skeleton.** Builds `wbhk-linux-x64` (the runner's native target) + a
   `checksums.txt`, and **guards the stamping in CI**: the staged binary must report exactly the tag version
   (`--version` assertion) — this is the automated regression guard the version-stamping slice (DIST-1)
   lacked. DIST-4 swaps the single build for the cross-compile matrix (all OS/arch — de-risked in the plan).

4. **Least privilege.** `permissions: contents: write` (only what a Release needs); `GH_TOKEN: github.token`
   (the ephemeral job token, no PAT); `concurrency` with `cancel-in-progress: false` so a release isn't
   interrupted mid-upload.

## consequences

- A tagged release produces a stamped, checksummed linux-x64 binary on a draft Release, ready to publish —
  the spine the rest of the distribution epic hangs off.
- No secrets, no signing, no public artifact yet (all later phases). The workflow is inert until the founder
  pushes the first `cli-v*` tag (or dispatches) — that first release is their call.
- The `--version` CI assertion closes the DIST-1 gap (the stamped path now has an automated guard).
- **Follow-up (DIST-8/9):** the bun installer is version-pinned, not SHA-pinned (matching ci.yml). The CI
  smoke binary is throwaway, but this workflow's artifact ships (as a draft) — so when signing lands and the
  supply-chain bar rises, SHA-pin the bun toolchain here. The manual-publish gate covers it until then.

## alternatives considered

- **Publish (non-draft) directly on tag.** Rejected for v1 — a draft keeps the first public release a human
  decision + lets the pipeline be tested without shipping anything.
- **A marketplace release action (e.g. softprops/action-gh-release).** Rejected — the org blocks non-GitHub
  publishers; the `gh` CLI is already on the runner and is the established pattern here.
- **Multi-platform now.** Deferred to DIST-4 — the skeleton proves the spine on one platform first (the
  cross-compile itself is already de-risked in the plan).
