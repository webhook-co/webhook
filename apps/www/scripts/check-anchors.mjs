// Built-HTML anchor integrity. Runs against the *emitted* out/ after `next build`, so it checks what
// actually ships — not what a component test thinks it renders.
//
// Three things it will not let you break:
//
//   1. **Every published legal anchor is still in the page.** The Vitest golden list proves the id
//      constant still exists; only this proves the page rendered it. Those are different failures.
//   2. **No duplicate ids.** A duplicate is an a11y violation and a deep link that silently resolves
//      to whichever section came first.
//   3. **No orphan fragments, including across pages.** The DPA links to /sub-processors and /terms.
//      If someone restructures Terms, the DPA's citation dies quietly — and this is the only check
//      that would notice.
//
// Legal anchors are pasted into signed agreements. A dead one is a compliance embarrassment, not a
// broken link.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Every published legal anchor, mirroring src/app/legal-anchors.ts. Kept in sync by its own test. */
export const REQUIRED_ANCHORS = {
  "terms.html": [
    "who-we-are",
    "what-the-service-does",
    "your-account",
    "acceptable-use",
    "your-data-and-content",
    "billing-and-refunds",
    "availability-and-support",
    "as-is",
    "limitation-of-liability",
    "indemnification",
    "suspension-and-termination",
    "changes",
    "intellectual-property",
    "governing-law",
    "enterprise-agreements",
    "general",
  ],
  "privacy.html": [
    "who-we-are",
    "controller-and-processor",
    "what-we-collect",
    "legal-basis",
    "sub-processors",
    "international-transfers",
    "retention",
    "your-rights",
    "security",
    "cookies",
    "children",
    "data-breaches",
    "california-residents",
    "changes",
    "contact",
  ],
  "dpa.html": [
    "scope",
    "controller-and-processor",
    "processing-details",
    "our-obligations",
    "security-measures",
    "sub-processors",
    "international-transfers",
    "assistance",
    "data-breaches",
    "return-and-deletion",
    "audits",
    "liability",
    "changes",
  ],
  "acceptable-use.html": [
    "scope",
    "why-this-is-strict",
    "prohibited-uses",
    "regulated-data",
    "monitoring",
    "enforcement",
    "reporting-abuse",
    "changes",
  ],
  "sub-processors.html": ["current-sub-processors", "changes"],
};

/** Every .html under a directory, recursively, as paths relative to it. */
export function htmlFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(full, base));
    else if (entry.name.endsWith(".html")) found.push(relative(base, full));
  }
  return found;
}

/**
 * Resolve an href to the out/ document it targets, or null if it isn't a local page fragment.
 * The static export emits `/terms` as `terms.html`, so `/dpa#sub-processors` → `dpa.html` + `#…`.
 */
export function resolveFragment(href, fromFile) {
  if (!href || href === "#") return null;
  if (/^[a-z]+:/i.test(href) || href.startsWith("//")) return null; // external / mailto / tel

  const hash = href.indexOf("#");
  if (hash === -1) return null;

  const path = href.slice(0, hash);
  let id;
  try {
    id = decodeURIComponent(href.slice(hash + 1));
  } catch {
    return { file: fromFile, id: null, malformed: href };
  }
  if (!id) return null;

  if (path === "") return { file: fromFile, id }; // same-page
  if (!path.startsWith("/")) return null; // relative — not emitted by this site

  const clean = path.replace(/\/$/, "").slice(1);
  return { file: clean === "" ? "index.html" : `${clean}.html`, id };
}

/** Ids declared in a document. Returns the list (with duplicates) so callers can detect collisions. */
export function idsIn(document) {
  return [...document.querySelectorAll("[id]")].map((el) => el.getAttribute("id"));
}

// Only the CLI path touches node:url / linkedom / the filesystem, so the pure helpers above stay
// importable from a Vitest (browser-ish) environment, where `import.meta.url` is not a file: URL.
if (import.meta.url.startsWith("file:") && process.argv[1]?.endsWith("check-anchors.mjs")) {
  const { fileURLToPath } = await import("node:url");
  const { parseHTML } = await import("linkedom");
  const OUT = fileURLToPath(new URL("../out/", import.meta.url));

  if (!existsSync(OUT)) {
    console.error(`✗ ${OUT} not found — run \`next build\` first.`);
    process.exit(1);
  }

  const errors = [];
  const docs = new Map();

  for (const file of htmlFiles(OUT)) {
    const { document } = parseHTML(readFileSync(join(OUT, file), "utf8"));
    docs.set(file, document);
  }

  // 1. every published legal anchor actually rendered
  for (const [file, required] of Object.entries(REQUIRED_ANCHORS)) {
    const document = docs.get(file);
    if (!document) {
      errors.push(`${file} was not emitted — the legal page is missing from the export`);
      continue;
    }
    for (const id of required) {
      if (!document.getElementById(id)) {
        errors.push(
          `${file}: published anchor #${id} is GONE. It is cited in signed agreements — restore it ` +
            `(an alias target is fine), don't rename it.`,
        );
      }
    }
  }

  // 2. no duplicate ids anywhere
  for (const [file, document] of docs) {
    const seen = new Set();
    for (const id of idsIn(document)) {
      if (seen.has(id)) errors.push(`${file}: duplicate id="${id}"`);
      seen.add(id);
    }
  }

  // 3. no orphan fragments, same-page or cross-page
  for (const [file, document] of docs) {
    for (const a of document.querySelectorAll("a[href]")) {
      const target = resolveFragment(a.getAttribute("href"), file);
      if (!target) continue;
      if (target.malformed) {
        errors.push(`${file}: malformed fragment ${target.malformed}`);
        continue;
      }
      const targetDoc = docs.get(target.file);
      if (!targetDoc) {
        errors.push(`${file}: link to ${target.file}#${target.id} — no such page in out/`);
      } else if (!targetDoc.getElementById(target.id)) {
        errors.push(`${file}: link to ${target.file}#${target.id} resolves to nothing`);
      }
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\nAnchor check failed: ${errors.length} error(s).`);
    process.exit(1);
  }

  const anchorCount = Object.values(REQUIRED_ANCHORS).flat().length;
  console.log(
    `✓ Anchor check passed (${anchorCount} published anchors across ${docs.size} pages).`,
  );
}
