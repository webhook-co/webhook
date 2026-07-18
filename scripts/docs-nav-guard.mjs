#!/usr/bin/env node
// Integrity guard for the Mintlify docs (apps/docs). Wired into `pnpm lint`.
//
// apps/docs is NOT a pnpm/turbo workspace — it has no package.json, and Mintlify builds it EXTERNALLY
// via its GitHub App on push to main. So nothing in CI ever looked at it: a nav entry pointing at a
// deleted page, a brand-new page nobody linked into the nav, a page missing its frontmatter, or a
// broken in-site cross-link all shipped green. The only check was a local `mint broken-links` that
// runs on a developer's laptop, if at all. This guard closes that hole deterministically, offline,
// on every PR.
//
// It PARSES — JSON for the nav, a frontmatter/link extractor for the pages — it never text-scans a
// structured file (guard-scripts-must-parse-not-scan). It carries a zero-input FLOOR: a docs.json
// that yields no nav pages, or a docs tree with no .mdx, fails rather than passing vacuously
// (a-guards-tests-must-run-the-guard).

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "out"]);
const REQUIRED_FRONTMATTER = ["title", "description"];

/** Recursively collect every page-path STRING leaf from a Mintlify `pages` array. */
function collectFromPages(pages, out) {
  for (const entry of pages ?? []) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (entry && typeof entry === "object") {
      // A nested group carries its own `pages`. An `openapi` group or an external `href` entry
      // generates/points elsewhere and has no local .mdx — skip it, don't treat it as a page.
      if (entry.openapi || entry.href) continue;
      if (Array.isArray(entry.pages)) collectFromPages(entry.pages, out);
    }
  }
}

/** Every local page path referenced anywhere in the nav (openapi/href entries excluded). */
export function collectNavPages(config) {
  const out = [];
  const nav = config?.navigation ?? {};
  for (const tab of nav.tabs ?? []) {
    if (Array.isArray(tab.pages)) collectFromPages(tab.pages, out);
    for (const group of tab.groups ?? []) {
      if (group.openapi) continue;
      if (Array.isArray(group.pages)) collectFromPages(group.pages, out);
    }
  }
  if (Array.isArray(nav.pages)) collectFromPages(nav.pages, out);
  for (const group of nav.groups ?? []) {
    if (group.openapi) continue;
    if (Array.isArray(group.pages)) collectFromPages(group.pages, out);
  }
  return out;
}

/** Parse the leading `--- ... ---` YAML frontmatter block into a flat key→string map. */
export function parseFrontmatter(src) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(src);
  if (!m) return { raw: null, data: {} };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    data[mm[1]] = v;
  }
  return { raw: m[1], data };
}

/**
 * Root-relative internal link targets (`/...`) from markdown `[t](/x)` and component `href="/x"`,
 * with anchors and query strings stripped and duplicates removed. External (`http`, `mailto:`),
 * relative (`../`), and anchor-only (`#`) links are not our concern — Mintlify/the browser own those.
 */
export function extractInternalLinks(src) {
  const targets = new Set();
  const add = (raw) => {
    if (!raw) return;
    let t = raw.trim();
    if (!t.startsWith("/")) return;
    t = t.split("#")[0].split("?")[0];
    if (t.length > 1) t = t.replace(/\/+$/, "");
    if (t) targets.add(t);
  };
  let m;
  const md = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  while ((m = md.exec(src)) !== null) add(m[1]);
  const href = /\bhref\s*=\s*["']([^"']+)["']/g;
  while ((m = href.exec(src)) !== null) add(m[1]);
  return [...targets];
}

async function* walkMdx(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // a missing tree yields nothing; the caller's floor turns that into a failure
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walkMdx(join(dir, entry.name));
    } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
      // README.md is repo documentation ABOUT the docs, not a rendered page — never in the nav.
      if (/^readme\.mdx?$/i.test(entry.name)) continue;
      yield join(dir, entry.name);
    }
  }
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Does a page path (no extension, relative to docsRoot) resolve to a real .mdx/.md file? */
async function pageFileExists(docsRoot, pagePath) {
  return (
    (await exists(join(docsRoot, `${pagePath}.mdx`))) ||
    (await exists(join(docsRoot, `${pagePath}.md`)))
  );
}

/**
 * Audit a Mintlify docs tree. Returns `{ pages, issues }`. Throws on the zero-nav-pages floor.
 * `generatedPrefixes`: first path segments whose pages are generated (e.g. the OpenAPI `api-reference`
 * operations) — links into them are not checked for a local file. `allowOrphans`: page paths that may
 * exist as files without a nav entry (e.g. intentionally unlisted snippets).
 */
export async function auditDocs({ docsRoot, generatedPrefixes = [], allowOrphans = [] }) {
  const config = JSON.parse(await readFile(join(docsRoot, "docs.json"), "utf8"));
  const navPages = collectNavPages(config);
  if (navPages.length === 0) {
    throw new Error(
      `docs.json under ${relative(ROOT, docsRoot) || docsRoot} parsed zero nav pages`,
    );
  }
  const navSet = new Set(navPages);
  const orphanAllow = new Set(allowOrphans);
  const genPrefixes = new Set(generatedPrefixes);
  const issues = [];

  // (1) Dangling nav — a nav entry with no backing file.
  for (const page of navPages) {
    if (!(await pageFileExists(docsRoot, page))) {
      issues.push({
        type: "dangling-nav",
        page,
        detail: `nav references "${page}" but no ${page}.mdx exists`,
      });
    }
  }

  // Collect the mdx tree once.
  const files = [];
  for await (const abs of walkMdx(docsRoot)) files.push(relative(docsRoot, abs));

  for (const file of files) {
    const pagePath = file.replace(/\.mdx?$/, "");

    // (2) Orphan — a page file no nav entry reaches.
    if (!navSet.has(pagePath) && !orphanAllow.has(pagePath)) {
      issues.push({ type: "orphan-page", file, detail: `${file} is not referenced by the nav` });
    }

    const src = await readFile(join(docsRoot, file), "utf8");

    // (3) Frontmatter — required keys present and non-empty.
    const { data } = parseFrontmatter(src);
    const missing = REQUIRED_FRONTMATTER.filter((k) => !data[k] || data[k].trim() === "");
    if (missing.length) {
      issues.push({
        type: "missing-frontmatter",
        file,
        detail: `missing frontmatter: ${missing.join(", ")}`,
      });
    }

    // (4) Broken internal links — a root-relative target with no page behind it.
    for (const target of extractInternalLinks(src)) {
      const clean = target.replace(/^\//, "");
      if (!clean) continue; // bare "/"
      const first = clean.split("/")[0];
      if (genPrefixes.has(first)) continue; // generated (e.g. openapi) — Mintlify owns these
      if (navSet.has(clean)) continue; // a nav page (may be generated/openapi-backed)
      if (!(await pageFileExists(docsRoot, clean))) {
        issues.push({
          type: "broken-link",
          file,
          target,
          detail: `${file} links ${target} → no such page`,
        });
      }
    }
  }

  return { pages: files.length, issues };
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const docsRoot = join(ROOT, "apps/docs");
  let result;
  try {
    result = await auditDocs({ docsRoot, generatedPrefixes: ["api-reference"] });
  } catch (err) {
    console.error(`✗ docs-nav-guard: ${err.message}`);
    process.exit(1);
  }
  if (result.pages === 0) {
    console.error("✗ docs-nav-guard: scanned 0 .mdx pages under apps/docs — the tree moved.");
    process.exit(1);
  }
  if (result.issues.length) {
    console.error("✖ docs nav / integrity problems:\n");
    for (const i of result.issues) console.error(`  [${i.type}] ${i.detail}`);
    console.error(
      "\napps/docs has no external CI but this gate does: fix the nav entry, link, or frontmatter above.",
    );
    process.exit(1);
  }
  console.log(`✔ docs nav OK — ${result.pages} pages, nav fully wired, internal links resolve.`);
}
