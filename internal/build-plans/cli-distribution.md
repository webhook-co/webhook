# CLI distribution — robust plan (`wbhk` shipping & release)

> **Status:** plan-only (no code). Scopes the distribution epic that was explicitly OUT of the Lane-D
> core-CLI plan. Founder direction (2026-06-24): **ship via ALL practical channels**; **defer paid
> signing** until accounts exist (everything else ships first); write a robust, sequenced plan before
> building. Build is **not yet authorized** — this is the artifact to review + sequence from.

## Context

`wbhk` (`packages/cli`) is feature-complete (Lane D: D0–D10 + the close-out hardening). It builds today as a
single `bun --compile` binary via `packages/cli/scripts/bundle.mjs` (the only "distribution" that exists —
a local, unsigned `dist/wbhk` used for dev/test + the CI `completion-smoke` job). There is no published
artifact: no npm package, no GitHub Release binaries, no package-manager recipes, and `VERSION` is hardcoded
`'0.0.0'` → reported as `0.0.0 (dev)`. This plan turns the local bundle into a real, multi-channel,
provenance-backed release pipeline.

**Repo facts [V]:** `bun --compile` is the binary toolchain (ADR for the bundle + the tsconfig-aside dance
in `scripts/bundle.mjs`); `VERSION` single-sourced in `packages/cli/src/version.ts` (`0.0.0`, no injector);
the org **blocks third-party GitHub Actions** — existing CDs (`deploy-wedge`, `deploy-web`, `deploy-auth`,
`www`) call tooling directly rather than use marketplace actions (see the deploy memories). Distribution CI
must respect that constraint.

## What "done" looks like

A maintainer pushes a version tag (e.g. `cli-v0.3.0`); CI then, in one run: builds the binary for every
target OS/arch, generates checksums + provenance, publishes the npm package, attaches the binaries +
checksums to a GitHub Release, and updates the package-manager manifests (Homebrew/Scoop) + the container
image. A user installs `wbhk` by whichever route they prefer, and `wbhk --version` / `wbhk doctor` report
the real version. `wbhk upgrade` self-updates a binary install.

---

## 1. Channels (ship all practical ones)

| Channel | Install UX | Artifact | Signing relevance | Priority |
| --- | --- | --- | --- | --- |
| **npm** | `npx wbhk` · `npm i -g wbhk` | node-runnable JS (tsc `dist/`) + `bin` shim | n/a (npm provenance, free) | **P1** |
| **Standalone binaries** | `curl -fsSL get.wbhk… \| sh`; or download from Releases | per-OS `bun --compile` binary on GitHub Releases | macOS Gatekeeper / Win SmartScreen (Phase 4) | **P1** |
| **Homebrew** | `brew install webhook-co/tap/wbhk` | a tap formula pointing at the Release binary/bottle | Homebrew sidesteps most Gatekeeper friction | **P2** |
| **Scoop** (Windows) | `scoop install wbhk` (bucket) | a manifest pointing at the Release `.exe` | reduces SmartScreen friction | **P2** |
| **Docker** | `docker run ghcr.io/webhook-co/wbhk …` | a small image (binary on a slim base) on GHCR | n/a | **P2** |
| **Winget / AUR / Nix** | platform-native | manifests | varies | **P3 (note, don't build v1)** |

**Decision needed — npm package shape.** Two options for npm:
- **(a) node-runnable JS** (`tsc dist/` + a `#!/usr/bin/env node` bin). Simplest; `npx wbhk` "just works"
  wherever Node ≥ 20 is installed; no binary download. **Recommended primary npm form.** (Confirm the CLI
  runs clean under plain `node` — it should: it uses `ws`, `node:*`, no bun-only APIs — but D's bundle dance
  exists because of the tsconfig `paths`, so the npm build needs its own `tsc`-emit + path-rewrite or a
  bundler step. A small spike confirms `node dist/bin.js` works end-to-end.)
- **(b) a thin installer package** that postinstalls the platform binary from the Release. More moving parts;
  reserve unless (a)'s Node-runtime requirement is unwanted.

---

## 2. Cross-cutting pieces (independent of channel)

- **VERSION stamping** — derive the version from the pushed git tag (`cli-vX.Y.Z`) → inject into
  `version.ts` at build (a generated constant or a `--define`), so the binary + npm package + `--version` +
  `doctor` all report it. Drop the `(dev)` suffix for a stamped build; keep it for a local bundle.
- **Release automation** — one workflow, tag-triggered, calling tooling directly (no 3rd-party actions, per
  the org constraint): build matrix → checksums → provenance → publish (npm + Release + manifests + image).
- **Provenance + integrity (all FREE)** — `npm publish --provenance` (GH Actions OIDC); SHA-256 `checksums.txt`
  for every binary; optional **sigstore** keyless signatures + **SLSA** build provenance for the binaries.
  None of these need a paid account.
- **`wbhk upgrade`** — opt-in self-update for a binary install: check the latest GitHub Release, download +
  verify the checksum, atomically replace the running binary. No-op / "use your package manager" for
  npm/brew/scoop installs (detect the install source).
- **`HTTP(S)_PROXY` support** — honor proxy env in the api-client + the tunnel (via `undici`'s
  `EnvHttpProxyAgent` for fetch + `ws`'s agent option). Small; folds into Phase 1.
- **OTel / telemetry** — silent, opt-out usage telemetry (founder leaned "silent telemetry" in the CLI
  redesign). Smallest value-add; sequence last + behind a clear opt-out + a privacy note.

---

## 3. Code-signing & notarization — explained (the founder asked)

**What it is.** When you hand someone a native executable, the OS tries to protect them from untrusted code:
- **macOS — Gatekeeper.** An unsigned / un-notarized binary that's been downloaded (quarantined) shows
  *"wbhk can't be opened because Apple cannot check it for malicious software"* — the user must right-click →
  Open, or `xattr -d com.apple.quarantine wbhk`. **Code-signing** signs it with an Apple Developer
  certificate; **notarization** uploads it to Apple to scan + "staples" a ticket, so it runs with no warning.
- **Windows — SmartScreen.** An unsigned `.exe` shows *"Windows protected your PC"* — the user clicks
  *More info → Run anyway*. A **code-signing certificate** (especially an **EV** cert) reduces/removes this.
- **Linux.** No OS gatekeeper; signing is optional — checksums + sigstore cover integrity.

**Is it required?** **No.** Unsigned artifacts work everywhere; users just see a one-time scary warning + an
extra click on macOS/Windows **for a directly-downloaded binary**. Crucially, the friction is **mostly
avoided** by the channels that don't trip quarantine: **npm**, **Homebrew**, **Scoop**, and a **`curl | sh`
installer** (it can strip the quarantine attribute) rarely hit Gatekeeper the way a double-clicked download
does. So we can ship a great experience **without paying for signing**, and add it later as polish.

**Cost (annual, approximate):**
- **Apple Developer Program** — **$99/yr** (covers signing + notarization for macOS).
- **Windows code-signing** — an OV cert **~$100–400/yr**, EV **~$300–700/yr**; or **Azure Trusted Signing**
  (~$10/mo, newer, cheaper) which many OSS projects now use.
- **npm provenance, sigstore, SLSA, checksums** — **free** (GitHub Actions OIDC).

**Recommendation:** **defer paid signing to Phase 4.** Ship npm + unsigned binaries (+ checksums + sigstore)
+ Homebrew/Scoop first; the `install.sh` clears the macOS quarantine bit so even the raw-binary path is
smooth. Add Apple notarization ($99/yr) + Windows signing once you decide it's worth it — the plan slots
them in without reworking earlier phases.

---

## 4. Slices (sequenced; each a gate-passing PR)

ADR numbers = claim-next-free at PR time (currently **0062+**).

### Phase 1 — foundations (no external accounts) · *self-merge-eligible*
- **DIST-1 VERSION stamping.** Tag → version injected into `version.ts` at build; `--version`/`doctor` report
  it; local bundle stays `(dev)`. Unit-test the resolver; **ADR** (version source + format).
- **DIST-2 proxy-env.** Honor `HTTP(S)_PROXY`/`NO_PROXY` in the api-client fetch + the `ws` tunnel. Tests via
  the injected fetch/agent seam.
- **DIST-3 release-workflow skeleton.** A tag-triggered workflow that builds the current-host binary +
  uploads it to a **draft/prerelease** GitHub Release with `checksums.txt`. Direct tooling (no 3rd-party
  actions). Proves the pipeline end-to-end on one platform before the matrix. **ADR** (release model).

### Phase 2 — binaries everywhere · *needs-founder (first public artifact)*
- **DIST-4 multi-platform matrix.** Build `bun --compile --target` for darwin-arm64/x64, linux-x64/arm64,
  win-x64; attach all + checksums to the Release. **✅ Spike DONE (2026-06-24): cross-compile works for ALL
  targets from ONE host** — proved on macOS-arm64 (bun 1.3.14): linux-x64-baseline (ELF x86-64),
  linux-arm64 (ELF aarch64), windows-x64-baseline (PE32+), darwin-arm64 + darwin-x64 (Mach-O) all built
  clean (the native one runs). So CI needs only a **single runner** (no per-OS matrix) — simpler + cheaper.
  Build notes: (a) use the **`-baseline` x64** targets to avoid "Illegal instruction" on pre-2013 CPUs
  (Bun's AVX2 SIMD warning; arm64 has no baseline); (b) the **Windows `.exe` metadata flags** (icon/version)
  can't be set when cross-compiling — skip for v1, or build win-x64 on a Windows runner just for metadata;
  (c) `bun-linux-*-musl` are separate targets if we want Alpine — defer; (d) VERSION via `--define` (DIST-1).
- **DIST-5 `install.sh`** — `curl -fsSL https://get.webhook.co | sh`: detect OS/arch, download the right
  binary, verify the checksum, install to `~/.local/bin` (or a PATH dir), clear the macOS quarantine bit.
  **Hosting (recommended): GitHub Releases for the binaries** (free CDN + checksums/provenance tied to the
  tag) **+ a thin `get.webhook.co` Cloudflare Worker** that serves `install.sh` + 302-redirects `latest`
  downloads to the Release assets. Branded one-liner + on-stack (CF), but the binaries stay on GitHub's CDN
  (don't re-host). Phase-2 can ship the raw Releases URL first; the Worker is a quick fast-follow.

### Phase 3 — npm + provenance · *needs-founder (publishes a public package)*
- **DIST-6 npm package.** Decide shape (§1; recommend node-runnable JS), produce the publishable `dist/` +
  `bin`, `npm publish --provenance` from CI on the tag. **Confirm the package name `wbhk` is available**
  (else `@webhook-co/cli`). Smoke `npx wbhk@<ver> --version` in CI post-publish.
- **DIST-7 sigstore + SLSA** for the binaries (free keyless signing + build provenance) + verify-on-`upgrade`.

### Phase 4 — signing (gated on founder accounts) · *needs-founder · infra-sensitive*
- **DIST-8 macOS notarization** (Apple Developer cert in CI secrets) — sign + notarize + staple the darwin
  binaries.
- **DIST-9 Windows signing** (OV/EV cert or Azure Trusted Signing) — sign `wbhk.exe`.

### Phase 5 — package managers + self-update + telemetry
- **DIST-10 Homebrew tap** (`webhook-co/homebrew-tap`) — formula auto-bumped on release.
- **DIST-11 Scoop bucket** + **DIST-12 Docker image** (GHCR).
- **DIST-13 `wbhk upgrade`** — self-update a binary install (checksum/sig-verified, atomic replace;
  source-aware no-op for managed installs). **ADR** (self-update model).
- **DIST-14 OTel telemetry** — silent, opt-out, privacy-noted. **ADR.**
- *(P3, note-only: Winget, AUR, Nix.)*

---

## 5. Decisions (✓ = resolved by the founder 2026-06-24)

1. **Channels** — ✓ **ALL practical** (npm, binaries, Homebrew, Scoop, Docker; Winget/AUR/Nix later).
2. **npm package shape** — node-runnable JS (recommended) vs a binary-installer package. (Confirm via Spike
   DIST-6 that the CLI runs under plain Node.)
3. **npm name** — ✓ **`wbhk`** (founder OK to claim; grab it early to reserve it).
4. **Signing** — ✓ **DEFER** (ship unsigned + free provenance now; add macOS notarization / Windows signing
   in Phase 4 only if/when accounts exist — Apple $99/yr, Windows ~$100–700/yr or Azure Trusted Signing).
5. **Release trigger + version source** — a `cli-vX.Y.Z` git tag (recommended) vs manual dispatch; version
   from the tag (recommended) vs `package.json`. *(open — low-stakes, recommend the tag.)*
6. **Telemetry** — confirm silent-opt-out is wanted + the privacy stance, or drop DIST-14. *(open.)*
7. **Distribution domain** — ✓ **recommendation: GitHub Releases for the binaries + a thin `get.webhook.co`
   Cloudflare Worker** (serves `install.sh` + 302→Release assets). Founder to confirm provisioning
   `get.webhook.co` (DNS + a tiny Worker, on the existing CF stack); not blocking — Phase 2 can ship the raw
   Releases URL first.

## 6. Risks

| Risk | Sev | Stance |
| --- | --- | --- |
| ~~Bun cross-target compile doesn't cover all OS/arch from one CI host~~ | ~~High~~ → **RESOLVED** | ✅ Spike done 2026-06-24: all 5 targets cross-compile from one macOS host (correct ELF/PE32+/Mach-O; native runs). Single-runner CI. Caveats: `-baseline` x64, Windows-metadata-needs-a-Windows-runner (skippable). |
| CLI doesn't run clean under plain Node (npm path) | Med | Spike DIST-6 (`node dist/bin.js` e2e); the tsconfig-paths dance from the bundle must be resolved for the npm build. |
| Org blocks 3rd-party GH Actions | Med | Call tooling directly (bun, npm, gh, cosign) — same pattern as the existing CDs. |
| Unsigned-binary friction (Gatekeeper/SmartScreen) | Med | install.sh clears quarantine; npm/brew/scoop avoid it; add signing in Phase 4. |
| Secret/cert handling in CI (Phase 4) | Med | Certs in repo secrets, least-priv, never logged; mirror the deploy-CD secret hygiene. |
| npm name unavailable | Low | Fall back to `@webhook-co/cli`. |

## 7. Gate & merge policy (per slice)

Same as Lane D: strict TDD where there's logic; full local gate (`lint` · `format:check` · `typecheck` ·
`test` · `build`) + `/code-review` + `/security-review`; per-slice ADR; rebased on `main`; CI green.
Self-merge the verifiable backend slices (DIST-1/2/3/6-logic/7/13-logic); **needs-founder** for the first
public artifacts (DIST-4/5/6-publish), anything touching **signing certs / release infra** (DIST-8/9), and
telemetry (DIST-14). Workflow/release-infra changes get an infra-review lens.
