#!/usr/bin/env node
// Build the standalone `wbhk` binary with `bun build --compile`.
//
// Why a wrapper and not a plain `bun build` script: packages/cli/tsconfig.json redirects the whole
// `@webhook-co/*` scope to the emitted `dist/index.d.ts` declarations (a TYPECHECK-only boundary so tsc
// doesn't re-check Workers-typed deps under node libs — see tsconfig.json). bun honors tsconfig `paths`
// at bundle time and would resolve those imports to the type-only `.d.ts` files (no runtime exports →
// "no matching export" at compile). So we move the tsconfig aside for the duration of the bundle — bun
// then resolves the deps to their TS source via each package's `exports` map — and ALWAYS restore it
// (try/finally), even if the build fails. Deterministic; no reliance on undocumented bun bundler flags.
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsconfig = join(cliDir, "tsconfig.json");
const stashed = join(cliDir, "tsconfig.json.bundlebak");

// Self-heal a PRIOR interrupted run: a hard kill (SIGINT/SIGKILL skips finally) between the two renames
// would leave the real tsconfig stashed + missing. Restore it before starting so the repo never wedges.
if (existsSync(stashed) && !existsSync(tsconfig)) renameSync(stashed, tsconfig);

renameSync(tsconfig, stashed);
let result;
try {
  result = spawnSync(
    "bun",
    ["build", "--compile", "--minify", "--sourcemap", "src/bin.ts", "--outfile", "dist/wbhk"],
    { cwd: cliDir, stdio: "inherit" },
  );
} finally {
  // Restore the tsconfig BEFORE exiting. process.exit() does not run finally blocks, so the exit is
  // deferred to after this restore (a process.exit inside the try would leave the tsconfig stashed).
  renameSync(stashed, tsconfig);
}
if (result.error) throw result.error;
process.exit(result.status ?? 1);
