#!/usr/bin/env node
// Fails if any component hard-codes an absolute-px font size (`text-[13px]`) instead of using the
// design-system scale. Wired into the `lint` script.
//
// Why this guard exists: the type scale in `packages/ui/src/tokens/typography.ts` is authored in
// **rem**, so the platform honors the reader's browser font-size preference. A `text-[13px]` opts
// that one element out of the preference *and* out of the scale — it keeps rendering 13px after the
// token behind `text-sm` moves, so it silently decouples and drifts. We shipped eight of these
// before this guard existed, every one of them an exact duplicate of a token value.
//
// Fluid display type (`text-[clamp(...)]`) is deliberately allowed: a marketing headline that
// interpolates across the viewport can't be expressed as a discrete step, and it still scales with
// zoom. `rem`/`em` arbitrary values are allowed for the same reason — they're root-relative.
//
// Non-type arbitrary px (a `h-[42px]` control, a `before:w-[3px]` rail) is NOT this script's
// business. Those are physical details, and forcing them to rem would push the rule past its point.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

// Only the trees that ship UI. Scanning the repo root would also read this file — whose comments and
// regex necessarily quote the pattern it bans — and report the guard as its own first violation.
const SCANNED = ["apps", "packages", "ee"];
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  ".wrangler",
  "out",
  ".open-next",
]);

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

// Tests never reach a reader, and this guard's own test necessarily quotes the very strings it
// bans. Scanning them would make the fixture a violation of itself.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * A Tailwind arbitrary *font-size* utility whose value is an absolute px length.
 *
 * `(?:^|[\s"'`])` anchors to a class-list boundary so we match `text-[13px]` and `sm:text-[13px]`
 * but not `scroll-mt-[13px]` — a utility that merely ends in the letters "text" is a different
 * property and none of our concern.
 */
const ABSOLUTE_TYPE = /(?:^|[\s"'`])((?:[a-z-]+:)*text-\[\d+(?:\.\d+)?px\])/g;

/** Pure core: every absolute-px type utility on one line. Exported so it can be tested directly. */
export function findAbsoluteTypeSizes(line, file, lineNo) {
  const hits = [];
  for (const match of line.matchAll(ABSOLUTE_TYPE)) {
    hits.push({ file, line: lineNo, match: match[1] });
  }
  return hits;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A scanned tree that isn't there is not an error: the open-core boundary means a self-host
    // checkout ships without `ee/` (see AGENTS.md). Crashing the lint gate on its absence would
    // break the build for exactly the people the boundary exists to serve.
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

/**
 * True when this module was run as a script (rather than imported by its test).
 *
 * `pathToFileURL`, not a hand-built `file://${argv[1]}` — the two agree today only because this
 * repo's path happens to contain no characters that need percent-encoding. Put the checkout under a
 * directory with a space in it and the naive comparison silently stops matching: the sweep never
 * runs, the script exits 0, and the lint gate becomes a no-op that still reports success. A guard
 * that can quietly stop guarding is worse than no guard, so `no-absolute-type-size.test.mjs` also
 * executes this file as a subprocess to prove the CLI path really runs.
 */
function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const violations = [];

  for (const tree of SCANNED) {
    for await (const file of walk(join(ROOT, tree))) {
      const contents = await readFile(file, "utf8");
      contents.split(/\r?\n/).forEach((line, idx) => {
        violations.push(...findAbsoluteTypeSizes(line, relative(ROOT, file), idx + 1));
      });
    }
  }

  if (violations.length > 0) {
    console.error("✖ Found absolute-px font sizes. Use the design-system scale instead:\n");
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.match}`);
    console.error(
      "\nThe type scale is rem-based so it honors the reader's browser font-size preference.\n" +
        "Use a token (text-xs/sm/base/md/lg/…), or an arbitrary rem value if you truly need one.\n" +
        "Fluid display type — text-[clamp(...)] — is allowed.",
    );
    process.exit(1);
  }

  console.log("✔ No absolute-px font sizes found.");
}
