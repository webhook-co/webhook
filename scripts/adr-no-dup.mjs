#!/usr/bin/env node
// Fails if two ADR files in docs/adr/ share the same NNNN number. An ADR number is a stable, cross-
// referenced identity — code comments and other ADRs cite "ADR-NNNN" — so a collision is ambiguous about
// which decision is meant. Every new `docs/adr/NNNN-*.md` must claim the next FREE number. Wired into the
// `lint` script (so it runs in the required `lint` CI job).
//
// This landed AFTER the close-out audit renumbered the 0044/0052/0055 CLI↔auth collisions — had it been in
// place earlier it would have red-flagged those dupes (which is exactly the point).

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ADR_DIR = join(process.cwd(), "docs", "adr");
// NNNN-kebab-name.md — the canonical ADR filename. Anything else (README, a template) is ignored.
const ADR_FILE = /^(\d{4})-[a-z0-9-]+\.md$/;

const entries = await readdir(ADR_DIR).catch((err) => {
  console.error(`adr-no-dup: cannot read ${ADR_DIR}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

const byNumber = new Map(); // "NNNN" -> [filename, ...]
for (const name of entries) {
  const m = ADR_FILE.exec(name);
  if (m === null) continue;
  const num = m[1];
  byNumber.set(num, [...(byNumber.get(num) ?? []), name]);
}

const dups = [...byNumber.entries()].filter(([, files]) => files.length > 1).sort();
if (dups.length > 0) {
  console.error(
    "adr-no-dup: duplicate ADR numbers (each ADR must claim a unique, next-free number):",
  );
  for (const [num, files] of dups) console.error(`  ${num}: ${files.sort().join(", ")}`);
  console.error(
    "Fix: renumber the newer ADR to the next free number + add a 'renumbered from NNNN' note, and update any inbound 'ADR-NNNN' references.",
  );
  process.exit(1);
}

console.log(`✔ ADR numbers: ${byNumber.size} unique, no duplicates.`);
