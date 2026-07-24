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

import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { isMain, walkDocs } from "./lib/docs-lib.mjs";

const ROOT = process.cwd();
const REQUIRED_FRONTMATTER = ["title", "description"];

// Static-asset extensions a doc may link to (images, downloads, media). A link ending in one of these
// is a file, not a page, so the broken-link check must not demand a `.mdx` behind it.
const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|pdf|zip|gz|tgz|csv|txt|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot)$/i;

/**
 * Every local page path referenced anywhere in the nav. Walks the WHOLE `navigation` object rather
 * than the three containers in use today (tabs/groups/pages): Mintlify also nests pages under
 * `dropdowns`, `anchors`, `languages`, and `versions`, and reorganizing docs.json into any of those
 * must not make every page beneath it look like an orphan. Any string that appears in a `pages` array
 * anywhere is a page; `openapi` (generated) and `href` (external) entries are not.
 */
export function collectNavPages(config) {
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.pages)) {
      for (const entry of node.pages) {
        if (typeof entry === "string") out.push(entry);
        else visit(entry);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "pages" || key === "openapi" || key === "href") continue;
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(config?.navigation ?? {});
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

/** Our GitHub org. A link that stops here is the defect this guard is about. */
const GITHUB_ORG = "webhook-co";

/**
 * Every GitHub link in the docs chrome that points at our ORG rather than at a repo.
 *
 * THE DEFECT: `footer.socials.github` shipped as `https://github.com/webhook-co`. That page is a repo
 * list — no README, no topics, and no star button. Docs is the only surface with measured search
 * impressions, so the one GitHub link a reader could find sent them somewhere with nothing to do.
 *
 * It WALKS the config rather than checking the two fields we know about today. A curated list of
 * places a link might hide only ever reports on the list (copy-guard-must-discover-not-list), and the
 * next person to add a GitHub link to `navbar.links` or an anchor can make the identical mistake.
 *
 * Third-party GitHub URLs are ignored — linking `standard-webhooks/standard-webhooks` is normal and
 * is not this guard's business. Only our own org is checked, because only our own org has a repo we
 * meant to send people to.
 *
 * THE ONE EXEMPTION, and it is keyed on what the guard MEANS rather than on a field name that
 * happened to trip it: this checks LINKS A READER CAN CLICK. `seo.organization.sameAs` is not a link,
 * it is a structured-data identity claim — and there the ORG profile is the correct node, because the
 * entity being described is the organisation, not one of its repositories. `apps/www`'s JSON-LD
 * asserts the same URL for the same reason. Exempting the `seo` subtree keeps the guard honest;
 * exempting "the field that failed" would have been the hole.
 *
 * Zero-input FLOOR: a missing config throws rather than returning `[]`. "Nothing was parsed" is a
 * different answer from "nothing was wrong", and a guard that cannot fail is not a guard.
 */
export function collectRepoLinkIssues(config) {
  if (!config || typeof config !== "object") {
    throw new Error("collectRepoLinkIssues: no config to inspect");
  }
  const issues = [];
  const seen = new Set();

  const check = (value) => {
    if (typeof value !== "string") return;
    const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)(\/[^?#\s]*)?/i.exec(value.trim());
    if (!m) return;
    if (m[1].toLowerCase() !== GITHUB_ORG) return; // someone else's org — not ours to police
    const rest = (m[2] ?? "").replace(/\/+$/, "");
    if (rest.length > 1) return; // …/webhook-co/<repo> — correct
    if (seen.has(value)) return;
    seen.add(value);
    issues.push({
      type: "github-org-link",
      href: value,
      detail: `${value} points at the ${GITHUB_ORG} ORG, not a repo — an org page has no star button. Use https://github.com/${GITHUB_ORG}/webhook`,
    });
  };

  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "string") {
      check(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "seo") continue; // structured-data identity, not a clickable link — see above
      visit(value);
    }
  };

  visit(config);
  return issues;
}

// Mintlify `snippets/` holds reusable fragments that are imported into pages — they are not nav pages
// and carry no frontmatter, so the page-level orphan/frontmatter checks must skip them. (The claims
// guard still scans them; a boast in a reused fragment ships just the same.)
const NON_PAGE_DIRS = ["snippets"];

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
export async function auditDocs({
  docsRoot,
  generatedPrefixes = [],
  allowOrphans = [],
  skipDirs = NON_PAGE_DIRS,
}) {
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

  // (0) Chrome links — a GitHub link that stops at the org instead of the repo.
  issues.push(...collectRepoLinkIssues(config));

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

  // Collect the doc tree once (pages only — snippets and other non-page dirs excluded).
  const files = [];
  for await (const abs of walkDocs(docsRoot, { skipDirs })) files.push(relative(docsRoot, abs));

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
      if (ASSET_EXT.test(clean)) continue; // an image/download/media file, not a page
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

if (isMain(import.meta.url)) {
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
