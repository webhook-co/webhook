# ADR 0070 — Homebrew tap (`brew install webhook-co/tap/wbhk`) (distribution DIST-10)

- status: accepted (distribution Phase 5 — package managers).
- date: 2026-06-24
- scope: new repo **`webhook-co/homebrew-tap`** (`Formula/wbhk.rb` + README); new
  `packages/cli/scripts/gen-homebrew-formula.mjs` (+ `homebrew-formula.test.ts`); an auto-bump step in
  `.github/workflows/release-cli.yml`; a README install line.
- relates: `internal/build-plans/cli-distribution.md` (DIST-10). ADR-0065 (the binaries the formula points at).
- review severity: medium (a public tap + a cross-repo CD push). `/code-review` + `/security-review`.

## context

After npm + binaries + `get.webhook.co`, Homebrew is the other P2 channel macOS/Linux users expect. A
**tap** (a separate `homebrew-<name>` repo) holds a formula so `brew install webhook-co/tap/wbhk` works.

## decision

1. **A binary formula, not build-from-source.** `wbhk` is a compiled Bun binary; the formula downloads the
   prebuilt, **sha256-pinned** release asset for the user's OS/arch (`on_macos`/`on_linux` × `on_arm`/
   `on_intel`) and installs it as `wbhk`. Windows is omitted (Homebrew is macOS + Linux). Verified live:
   `brew install webhook-co/tap/wbhk` installs 0.1.1 and `wbhk --version` runs.

2. **The formula is GENERATED, one source of truth.** `gen-homebrew-formula.mjs` builds `wbhk.rb` from a
   version + the release `checksums.txt`; its pure core (`buildFormula`/`parseChecksums`) is unit-tested (a
   wrong URL or swapped platform would ship a broken `brew install`). The initial `0.1.1` formula was
   generated + committed to the tap by hand; releases regenerate it.

3. **Auto-bump on release.** `release-cli.yml` regenerates the formula from the just-built `checksums.txt`
   and pushes it to the tap. The cross-repo push needs **`HOMEBREW_TAP_TOKEN`** (a token with
   `contents:write` on `webhook-co/homebrew-tap` — the ephemeral `GITHUB_TOKEN` is scoped to the build repo
   only). Auth via `gh auth setup-git` (the token rides `GH_TOKEN`, never embedded in a URL/args). The step
   is **inert until that secret is set** + real tags only — so it's safe to merge now; the founder adds the
   token to switch it on.

## consequences

- `brew install webhook-co/tap/wbhk` works today (formula pinned to 0.1.1); once `HOMEBREW_TAP_TOKEN` is set,
  every release bumps the tap automatically — no manual formula edits, no drift (the digests come straight
  from the release's `checksums.txt`).
- The tap install lands in the Cellar, so `wbhk upgrade` correctly classifies it as a Homebrew install (it
  defers to `brew upgrade` rather than self-replacing — cross-checked live).
- **Founder action to finish auto-bump:** add a repo secret `HOMEBREW_TAP_TOKEN` on `webhook-co/webhook` — a
  fine-grained PAT scoped to `webhook-co/homebrew-tap` with **Contents: read & write** (least-priv; not the
  broad admin token). Until then the formula is bumped by re-running the generator + pushing by hand.

## alternatives considered

- **Build-from-source formula.** Rejected — `wbhk` is a compiled binary; a source build would need the full
  Bun toolchain in the formula for marginal benefit. The checksum-pinned binary is the norm for compiled CLIs.
- **Hand-maintained formula.** Rejected — drift between the formula's pins and the published binaries is the
  classic tap failure mode; generating from `checksums.txt` makes them the same artifact.
- **Reuse the broad gh/admin token for the cross-repo push.** Rejected — a least-priv fine-grained PAT scoped
  to just the tap is the right blast radius for a public-repo CI secret.
- **`brew bump-formula-pr` / a homebrew-side workflow.** Heavier (a PR dance / a tap-side CI + a dispatch
  token); a direct generate-and-push from the release run is simpler and keeps the generator in the monorepo.
