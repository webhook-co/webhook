#!/usr/bin/env node
// Build EVERY release `wbhk` binary, cross-compiled from a single host via `bun build --compile --target`
// (proven viable — see internal/build-plans/cli-distribution.md DIST-4), into packages/cli/out/. DIST-4.
//
// Requires: bun on PATH + WBHK_BUILD_VERSION (the cli-vX.Y.Z tag's version) to stamp the binary (ADR-0062).
// Uses the same tsconfig-aside dance as bundle.mjs (bun honors tsconfig `paths` at bundle time and would
// resolve the workspace deps to type-only .d.ts; moving it aside makes bun resolve them to TS source via
// each package's `exports`). Restored in a finally, with a self-heal for a prior interrupted run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(cliDir, "out");
const tsconfig = join(cliDir, "tsconfig.json");
const stashed = join(cliDir, "tsconfig.json.bundlebak");

const version = process.env.WBHK_BUILD_VERSION;
if (version === undefined || version.length === 0) {
  console.error("release-build: WBHK_BUILD_VERSION is required (the release version, e.g. 0.3.0)");
  process.exit(1);
}

// bun --target → the published asset name. `-baseline` for x64 (Bun's AVX2 SIMD needs a modern CPU; baseline
// runs on pre-2013 CPUs too — the safe default for a distributed binary); arm64 has no baseline variant.
const TARGETS = [
  { target: "bun-darwin-arm64", asset: "wbhk-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "wbhk-darwin-x64" },
  { target: "bun-linux-x64-baseline", asset: "wbhk-linux-x64" },
  { target: "bun-linux-arm64", asset: "wbhk-linux-arm64" },
  { target: "bun-windows-x64-baseline", asset: "wbhk-windows-x64.exe" },
];

if (existsSync(stashed) && !existsSync(tsconfig)) renameSync(stashed, tsconfig); // self-heal a prior run
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

renameSync(tsconfig, stashed);
let failed = false;
try {
  for (const { target, asset } of TARGETS) {
    const result = spawnSync(
      "bun",
      [
        "build",
        "--compile",
        "--minify",
        "--sourcemap",
        "--define",
        `WBHK_VERSION=${JSON.stringify(version)}`,
        `--target=${target}`,
        "src/bin.ts",
        "--outfile",
        join(outDir, asset),
      ],
      { cwd: cliDir, stdio: "inherit" },
    );
    if (result.error !== undefined || result.status !== 0) {
      console.error(`release-build: ${target} failed`);
      failed = true;
      break;
    }
    console.log(`✓ ${asset} (${target})`);
  }
} finally {
  renameSync(stashed, tsconfig); // restore BEFORE any exit (process.exit skips finally otherwise)
}
if (failed) process.exit(1);

// Drop any non-asset byproduct bun leaves behind (e.g. a stray external bin.js.map from --sourcemap; the
// map is also embedded in the binary) so only the wbhk-* binaries + checksums.txt ship.
for (const f of readdirSync(outDir)) {
  if (!f.startsWith("wbhk-")) rmSync(join(outDir, f), { force: true });
}

// checksums.txt in `sha256sum` format (`<hex>  <name>`) — exactly what install.sh verifies with `-c`.
const assets = readdirSync(outDir)
  .filter((f) => f.startsWith("wbhk-"))
  .sort();
const checksums = assets
  .map(
    (f) =>
      `${createHash("sha256")
        .update(readFileSync(join(outDir, f)))
        .digest("hex")}  ${f}`,
  )
  .join("\n");
writeFileSync(join(outDir, "checksums.txt"), `${checksums}\n`);
console.log(`✓ checksums.txt (${assets.length} assets) → ${outDir}`);
