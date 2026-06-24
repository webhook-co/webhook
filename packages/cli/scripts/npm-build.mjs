#!/usr/bin/env node
// Build the publishable `wbhk` npm package into packages/cli/npm/ — a node-runnable bundle (NOT a
// `bun --compile` binary). DIST-6. Spike-confirmed the CLI runs clean under plain Node (uses ws / node:* /
// no bun-only APIs; keychain shells out, so no native .node), so the npm form is a single bundled
// dist/bin.js + a generated, self-contained package.json (no `workspace:*` deps — everything is inlined).
//
// Requires: bun on PATH + WBHK_BUILD_VERSION (the cli-vX.Y.Z tag's version) to stamp the version (ADR-0062).
// Same tsconfig-aside dance as bundle.mjs/release-build.mjs (bun honors tsconfig `paths` at bundle time and
// would resolve the workspace deps to type-only .d.ts; moving it aside resolves them to TS source via each
// package's `exports`). Restored in a finally, with a self-heal for a prior interrupted run.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNpmManifest } from "./npm-manifest.mjs";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(cliDir, "npm");
const distDir = join(outDir, "dist");
const tsconfig = join(cliDir, "tsconfig.json");
const stashed = join(cliDir, "tsconfig.json.bundlebak");

const version = process.env.WBHK_BUILD_VERSION;
if (version === undefined || version.length === 0) {
  console.error("npm-build: WBHK_BUILD_VERSION is required (the release version, e.g. 0.3.0)");
  process.exit(1);
}

if (existsSync(stashed) && !existsSync(tsconfig)) renameSync(stashed, tsconfig); // self-heal a prior run
rmSync(outDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

renameSync(tsconfig, stashed);
let result;
try {
  result = spawnSync(
    "bun",
    [
      "build",
      "--target=node",
      "--minify",
      "--sourcemap",
      "--define",
      `WBHK_VERSION=${JSON.stringify(version)}`,
      "src/bin.ts",
      // --outdir (not --outfile): with external --sourcemap bun emits bin.js + bin.js.map, and --outfile
      // (single-output only) is silently ignored — the files land next to the entry. --outdir names the
      // output after the entry basename → npm/dist/bin.js (matching the `bin` field) + bin.js.map.
      "--outdir",
      distDir,
    ],
    { cwd: cliDir, stdio: "inherit" },
  );
} finally {
  renameSync(stashed, tsconfig); // restore BEFORE any exit (process.exit skips finally otherwise)
}
if (result.error !== undefined || result.status !== 0) {
  console.error("npm-build: bundle failed");
  process.exit(1);
}

writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify(buildNpmManifest(version), null, 2)}\n`,
);
copyFileSync(join(cliDir, "README.md"), join(outDir, "README.md"));
console.log(`✓ npm package wbhk@${version} → ${outDir}`);
