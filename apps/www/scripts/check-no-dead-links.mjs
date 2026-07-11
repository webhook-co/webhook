#!/usr/bin/env node
// Post-build guard: the marketing site ships NO link to nowhere.
//
// `href="#"` was the site's standing tech debt — 40 of them across nine components, with the footer's
// own comment calling them "placeholders owned by the L3 wiring lane". They're all gone now: the ones
// with a real destination were wired, and the handful of surfaces that genuinely don't exist (About,
// Blog, the socials, a status page) render as TEXT rather than as links that go nowhere.
//
// This runs on the EMITTED out/, not the source, because that's what a visitor actually gets. A dead
// link is worse than a missing one: it announces as a link to a screen reader, it's a tab stop, and —
// since smooth scrolling is enabled by the first click — `href="#"` now glides the reader all the way
// back to the top of the page.
//
// `href="#main"` (the skip link) and the legal `#section` anchors are real in-page targets, and are
// verified separately by check-anchors.mjs. Only a bare `#` is a link to nowhere.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../out/", import.meta.url));

/** Every `href="#"` — a link whose destination is the top of the current page, i.e. nothing. */
export const DEAD_LINK = /<a[^>]+href="#"/g;

function htmlFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(full, base));
    else if (entry.name.endsWith(".html")) found.push(relative(base, full));
  }
  return found;
}

if (!existsSync(OUT)) {
  console.error(`✗ ${OUT} not found — run \`next build\` first.`);
  process.exit(1);
}

const offenders = [];
const pages = htmlFiles(OUT);

for (const file of pages) {
  const count = (readFileSync(join(OUT, file), "utf8").match(DEAD_LINK) ?? []).length;
  if (count > 0) offenders.push(`${file}: ${count} × href="#"`);
}

if (offenders.length > 0) {
  console.error('✖ Found links that go nowhere (href="#"):\n');
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    "\nWire it to a real destination (see src/lib/links.ts), or — if the surface genuinely does not\n" +
      "exist yet — render the label as TEXT instead of as a link. A dead link is a tab stop that\n" +
      "announces as a link and, with smooth scrolling on, yanks the reader back to the top.",
  );
  process.exit(1);
}

console.log(`✔ No dead links — checked ${pages.length} pages.`);
