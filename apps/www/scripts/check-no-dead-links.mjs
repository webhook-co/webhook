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

import { isMainModule } from "./check-seo-html.mjs";

/**
 * An `<a>` whose href is a bare `#` — a link whose destination is the top of the current page.
 *
 * The closing quote right after `#` is what keeps it precise: `href="#main"` and
 * `href="/dpa#sub-processors"` are real targets and must not trip it. `[^>]+` is a negated class, not
 * `.`, so it spans newlines between attributes without needing the `s` flag — attribute ORDER can't
 * hide a dead link either. Every byte of HTML in out/ is React-emitted (public/ holds no hand-written
 * .html), so double-quoted lowercase attributes are the only form we have to catch.
 */
export const DEAD_LINK = /<a[^>]+href="#"/g;

/** Every `.html` under a directory, recursively, relative to it. */
export function htmlFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(full, base));
    else if (entry.name.endsWith(".html")) found.push(relative(base, full));
  }
  return found;
}

/** Count the dead links in one document. Pure, so the regex is testable without a build. */
export function countDeadLinks(html) {
  return (html.match(DEAD_LINK) ?? []).length;
}

// Only sweep the filesystem when RUN as a script, so the pure helpers above stay importable from a
// test. Without this, importing the module would walk out/, print, and call process.exit() — killing
// the test worker. isMainModule (shared) is symlink-safe: a naive `file://` + argv[1] compare
// silently no-ops under a symlinked checkout, which for a required gate means passing unchecked.
if (isMainModule(import.meta.url, process.argv[1])) {
  const OUT = fileURLToPath(new URL("../out/", import.meta.url));

  if (!existsSync(OUT)) {
    console.error(`✗ ${OUT} not found — run \`next build\` first.`);
    process.exit(1);
  }

  const pages = htmlFiles(OUT);

  // A guard on the guard. `existsSync` catches a MISSING out/, not an EMPTY one — so a build that
  // silently emitted nothing (or a moved distDir, or a cleaned tree) would sail through with
  // "✔ No dead links — checked 0 pages." A check that reports success when it checked nothing is
  // worse than no check, because it looks like coverage.
  if (pages.length === 0) {
    console.error(
      `✗ ${OUT} contains no .html — the build emitted nothing. Refusing to pass vacuously.`,
    );
    process.exit(1);
  }

  const offenders = [];
  for (const file of pages) {
    const count = countDeadLinks(readFileSync(join(OUT, file), "utf8"));
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
}
