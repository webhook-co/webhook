// Shared helpers for the two docs guards (no-unverified-claims.mjs, docs-nav-guard.mjs) so the set of
// ignored directories, the "am I the entrypoint" check, and the docs-file walker stay in lockstep
// instead of drifting between two copies.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "out"]);

/** True when this module's caller was run directly (not imported). Pass `import.meta.url`. */
export function isMain(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * Yield every documentation source file (`.mdx`/`.md`) under `dir`, skipping IGNORED_DIRS, any extra
 * `skipDirs` (e.g. Mintlify `snippets/` for the nav guard, which are reusable fragments, not pages),
 * and README files (repo documentation about the docs, never a rendered page).
 *
 * Both guards agree on what a doc FILE is (.mdx + .md); they differ only in which DIRECTORIES count —
 * hence `skipDirs`. The claims guard scans snippets (a boast in a reused fragment still ships); the
 * nav guard excludes them (a fragment is not a nav page and carries no frontmatter).
 */
export async function* walkDocs(dir, { skipDirs = [] } = {}) {
  const skip = new Set([...IGNORED_DIRS, ...skipDirs]);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // a missing tree yields nothing; the caller's floor turns that into a failure
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      yield* walkDocs(join(dir, entry.name), { skipDirs });
    } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
      if (/^readme\.mdx?$/i.test(entry.name)) continue;
      yield join(dir, entry.name);
    }
  }
}
