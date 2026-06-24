# ADR 0066 — `wbhk` npm package (distribution DIST-6)

- status: accepted (distribution Phase 3 — npm + provenance).
- date: 2026-06-24
- scope: new `packages/cli/scripts/npm-build.mjs` + `packages/cli/scripts/npm-manifest.mjs` +
  `packages/cli/README.md`; `.github/workflows/release-cli.yml` (build + smoke + gated publish);
  `packages/cli/src/npm-manifest.test.ts`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-6; DIST-7 sigstore/SLSA next). ADR-0062 (version
  stamping), ADR-0064 (release workflow), ADR-0065 (binaries + installer).
- review severity: medium (release artifact + a publish step that ships a public package). `/code-review` +
  `/security-review`.

## context

The CLI ships as standalone binaries (ADR-0065) and via `curl | sh`. npm is the other P1 channel — `npx wbhk`
/ `npm i -g wbhk` for anyone who already has Node. The internal workspace package `@webhook-co/cli` can't be
published as-is: it's `private`, and it depends on `@webhook-co/contract` / `@webhook-co/shared` via
`workspace:*`, which `npm install` can't resolve.

## decision

1. **npm shape = node-runnable bundle (plan option a), not a binary-installer package.** Spike-confirmed the
   CLI runs clean under plain Node ≥ 20 (it uses `ws` / `node:*`, no bun-only APIs; the keychain backend
   shells out, so there's no native `.node` to embed): `node dist/bin.js` runs `--version`, `--help`, real
   commands, and completions. So npm ships a single **node-target `bun build` bundle** (`dist/bin.js`, with
   the workspace deps inlined) + a generated, self-contained `package.json` — **no runtime `dependencies`**,
   so `npm install` can't break on a transitive resolution. (`bun build --target=node`, not `--compile`.)

2. **The published `package.json` is GENERATED, not the workspace manifest.** `npm-manifest.mjs`
   (`buildNpmManifest(version)`, unit-tested) produces the public manifest: name `wbhk`, `bin`, `files`
   (`dist` + `README.md` only), `engines.node >=20`, `type: module`, Apache-2.0, `repository` (required for
   provenance), and `publishConfig: { access: public, provenance: true }`. The tests pin that it is **not**
   `private`, declares **no** deps, and never leaks a `workspace:` string — a regression there ships a broken
   or mis-published package.

3. **Build via `--outdir`, not `--outfile`.** With external `--sourcemap` bun emits `bin.js` + `bin.js.map`
   (two outputs) and silently ignores `--outfile`, dropping the files next to the entry. `--outdir` names the
   output after the entry basename → `dist/bin.js` (matching `bin`) + the map. Same tsconfig-aside dance as
   `bundle.mjs` / `release-build.mjs` (so bun resolves workspace deps to source), restored in a `finally`.

4. **Workflow: build + smoke always; publish gated.** `release-cli.yml` builds the npm package and asserts
   its `--version` == the tag on **every** run (dispatch or tag), so the npm path is continuously exercised.
   `npm publish` runs **only** on a real tag push **and** only when `NPM_TOKEN` is configured — until the
   founder claims the name + adds the token it's inert, so the first public publish is a deliberate human
   action (mirroring the draft-Release model). Provenance is free (GitHub OIDC, `id-token: write`).

## consequences

- A tagged release builds a node-runnable npm package; once `NPM_TOKEN` is set, it publishes with provenance.
  `npx wbhk` / `npm i -g wbhk` work on any Node ≥ 20 host, no binary download, no Gatekeeper friction.
- The published package is self-contained (zero deps) — bigger bundle (~475 kB gzipped, incl. a sourcemap for
  debuggable stack traces) but no install-time resolution surface.
- The generated `packages/cli/npm/` is gitignored (a build artifact).
- The manifest logic is the one unit-tested piece; the orchestration scripts are verified empirically (like
  `bundle.mjs` / `release-build.mjs`) + by the CI smoke.
- **Follow-up flagged:** the repo declares `license: Apache-2.0` in `package.json` but ships **no LICENSE
  file** anywhere — an open-core gap worth fixing repo-wide (the npm package uses the valid SPDX field for now).

## alternatives considered

- **A binary-installer npm package** (postinstall downloads the platform binary). Rejected — more moving parts
  + a network postinstall; only needed if the Node-runtime requirement were unwanted, and it isn't.
- **Publish the workspace manifest with a `prepublishOnly` rewrite.** Rejected — generating a clean manifest
  into an isolated dir is simpler and can't accidentally publish `workspace:` deps or `private`.
- **`tsc`-emit `dist/` instead of bundling.** Rejected — the workspace deps aren't published, so a tsc emit
  would need them resolved/published separately; a single bundle sidesteps that entirely.
