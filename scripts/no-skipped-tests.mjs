#!/usr/bin/env node
// Fails if any focused or skipped/disabled tests are committed. This is wired into both the
// `lint` script and the `no-skipped-tests` CI job. It exists so that no one can quietly land a
// green build by focusing one test (`.only`) or skipping the ones that fail (`.skip`).
//
// NON-NEGOTIABLE (see AGENTS.md): never weaken tests to make CI pass. Fix the root cause.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".wrangler",
]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Patterns that indicate a focused or disabled test.
const FORBIDDEN = [
  {
    label: "focused test (.only)",
    re: /\b(?:describe|it|test|context|bench|suite)\s*\.\s*only\s*\(/,
  },
  {
    label: "skipped test (.skip)",
    re: /\b(?:describe|it|test|context|bench|suite)\s*\.\s*skip\s*\(/,
  },
  { label: "focused test (fdescribe/fit)", re: /\b(?:fdescribe|fit)\s*\(/ },
  { label: "disabled test (xdescribe/xit/xtest)", re: /\b(?:xdescribe|xit|xtest)\s*\(/ },
];

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const violations = [];

for await (const file of walk(ROOT)) {
  const contents = await readFile(file, "utf8");
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const { label, re } of FORBIDDEN) {
      if (re.test(line)) {
        violations.push(`${relative(ROOT, file)}:${idx + 1}  ${label}  ->  ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("\u2716 Found focused/skipped tests. Remove these before committing:\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error("\nNever skip or focus tests to make CI pass. Fix the root cause (see AGENTS.md).");
  process.exit(1);
}

console.log("\u2714 No focused or skipped tests found.");
