#!/usr/bin/env node
// Anti-thin-content guard for the programmatic provider pages. Fails if any two SHIPPED pages are
// near-duplicates, or if any page falls below a substance floor. Wired into `pnpm lint`.
//
// WHY a manifest and not built HTML: the estate is CROSS-HOST — "how to test {provider} webhooks
// locally" tutorials on www (Next static export) AND "verify {provider} signature" references on docs
// (Mintlify, built off-repo). No single `out/` holds both, and both are generated from the SAME
// registry recipe rows, so a www tutorial can silently near-duplicate its docs reference with no
// per-host check able to see it. So the page generators (www + docs) each emit their pages' rendered
// body text into a committed fragment, and this guard MERGES every fragment into one analysis set and
// dedupes ACROSS the whole estate. Merging is the load-bearing part: analyzed per-fragment, a docs
// page and its www counterpart are never a pair, and the cross-host check never runs.
//
// PARSE, don't scan; and fail-closed FLOORS throughout. Nothing here is idle: a missing fragment, a
// fragment below the discovery floor, an empty page set, or a shipped page absent from the manifest
// all EXIT 1. The sibling content-dup-guard.test.mjs runs the guard on fixtures every CI run.
//
// A fragment's shape: { pages: [{ id, host, path, intent, name, header, text }] } where `text` is the
// page's rendered, human-visible body (markup already stripped by the generator).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/docs-lib.mjs";

// ── Tunable, named, defensible thresholds ────────────────────────────────────────
export const SHINGLE_K = 5; // word-level 5-grams
export const NEAR_DUP_JACCARD = 0.8; // ≥ this over 5-gram sets ⇒ near-duplicate
export const MIN_BODY_WORDS = 150; // a real per-provider page clears this
export const MIN_UNIQUE_SHINGLES = 40; // …and carries this much distinct 5-gram substance

// Where the committed fragments live. One per host, because a package may not reach into an app to
// read its data. Paths are fixed + module-relative — never user input.
//
// An earlier version treated an absent manifest as "idle" and exited 0. That was right before any
// page shipped and is a hole now that fragments are committed: deleting one would silently drop a
// whole host from the estate. Every discovered fragment must load, and the discovery itself has a
// floor.
export const GENERATED_DIR = fileURLToPath(new URL("./generated/", import.meta.url));
export const MIN_FRAGMENTS = 2; // docs + www. A third estate needs no code change here.

// The inventories the guard checks its own input against. These are SHIPPED-SURFACE directories, not
// anything either generator consults — the point is to verify coverage from the outside.
export const DOCS_PROVIDERS_DIR = fileURLToPath(
  new URL("../apps/docs/providers/", import.meta.url),
);
export const WWW_TEST_ROUTES_DIR = fileURLToPath(
  new URL("../apps/www/src/app/test/", import.meta.url),
);

/**
 * Every committed `*-pages.json` fragment, discovered from disk.
 *
 * Deliberately NOT a hardcoded list. Scoping the manifest to one generator's output is what made the
 * original gap self-concealing; a hand-maintained list of fragments would reproduce that defect one
 * level up — a new estate emits a fragment, nobody edits the array, and the guard reports "clean"
 * over a set that silently excludes it. THROWS below the floor: discovering one fragment (or none)
 * means an estate vanished, which must never read as coverage.
 */
export function discoverFragments(dir = GENERATED_DIR) {
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith("-pages.json"))
        .sort()
        .map((f) => join(dir, f))
    : [];
  if (found.length < MIN_FRAGMENTS) {
    throw new Error(
      `content-dup-guard: found ${found.length} manifest fragment(s) in ${dir}, expected at least ${MIN_FRAGMENTS} (fail-closed floor)`,
    );
  }
  return found;
}

/**
 * Pages that SHIP but are absent from the manifest.
 *
 * This lives in the guard, next to the floor, on purpose. The generators assert their own
 * completeness in their own test files — but those run under `pnpm test` while the floor runs under
 * `pnpm lint`, and "the builder enumerated correctly" is exactly the assumption that failed here. A
 * fragment holding 3 of 20 pages passes every quantity check the guard has and still prints "all
 * above the substance floor". So: read the shipped estate off disk and compare.
 *
 * `.md` counts as a page — `docs-nav-guard` treats it as one, so a glob that saw only `.mdx` would
 * let one ship unmeasured.
 */
export function checkCoverage(
  pages,
  { docsDir = DOCS_PROVIDERS_DIR, wwwTestDir = WWW_TEST_ROUTES_DIR } = {},
) {
  const missing = [];
  // A PREFIX strip, not `String.replace` — replace() substitutes the first occurrence ANYWHERE, so a
  // malformed path would pass through unchanged and then be reported as "shipped page absent from
  // the manifest" when the truth is "manifest entry has a bad path". Say which one it is.
  const slugsFor = (host, prefix) =>
    new Set(
      pages
        .filter((p) => p.host === host)
        .map((p) => {
          if (!p.path.startsWith(prefix)) {
            throw new Error(`content-dup-guard: manifest entry ${p.id} has no ${prefix} path`);
          }
          return p.path.slice(prefix.length);
        }),
    );
  const inventory = (label, found, covered) => {
    if (found.length === 0) {
      throw new Error(
        `content-dup-guard: refusing to check coverage against an empty ${label} inventory`,
      );
    }
    for (const slug of found) if (!covered.has(slug)) missing.push(`${label}:${slug}`);
  };

  inventory(
    "docs",
    readdirSync(docsDir)
      .filter((f) => /\.mdx?$/.test(f))
      .map((f) => f.replace(/\.mdx?$/, "")),
    slugsFor("docs", "/providers/"),
  );
  inventory(
    "www",
    readdirSync(wwwTestDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(wwwTestDir, d.name, "page.tsx")))
      .map((d) => d.name),
    slugsFor("www", "/test/"),
  );
  return missing.sort();
}

/**
 * Read every declared fragment and concatenate their pages. THROWS on a missing fragment, on
 * unreadable JSON, on a fragment carrying no pages, and on an id claimed by two fragments — an id
 * collision would let one host's entry stand in for another's and mask a page from the floor.
 */
export function loadManifests(paths) {
  const pages = [];
  const seen = new Set();
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new Error(`content-dup-guard: declared manifest fragment is missing: ${path}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`content-dup-guard: manifest is unreadable/invalid JSON: ${e.message}`, {
        cause: e,
      });
    }
    const fragment = manifest?.pages;
    if (!Array.isArray(fragment) || fragment.length === 0) {
      throw new Error(`content-dup-guard: fragment carries no pages (fail-closed floor): ${path}`);
    }
    for (const page of fragment) {
      // `host` and `path` are what checkCoverage matches a shipped page against. A missing one would
      // otherwise surface as a property-read TypeError deep inside the coverage pass — fail-closed
      // either way, but unreadable. Name the offending entry here instead. (`id`/`text` are checked
      // by analyzePages, which owns the analysis contract.)
      if (typeof page?.host !== "string" || typeof page?.path !== "string") {
        throw new Error(
          `content-dup-guard: malformed page entry ${JSON.stringify(page)?.slice(0, 120)}`,
        );
      }
      if (seen.has(page.id)) {
        throw new Error(`content-dup-guard: duplicate page id across fragments: ${page.id}`);
      }
      seen.add(page.id);
      pages.push(page);
    }
  }
  return pages;
}

/** Lowercase, strip everything non-alphanumeric to spaces, collapse + trim. */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Neutralize the provider's own brand name (and optional extra tokens like its header) to a placeholder
 * BEFORE shingling. Substring match, not word-boundary — measured across the whole shipped estate,
 * no brand token matches mid-word, and a boundary would miss hyphenated header forms. The brand name is the LEGITIMATE per-provider differentiator, so leaving it in makes
 * two same-template pages (github vs meta) look ~45% different purely because the name is swapped ~10×.
 * Neutralizing it measures the page STRUCTURE — the real thin-doorway signal — not the brand token.
 */
export function neutralize(text, name, extra = []) {
  let out = String(text);
  for (const token of [name, ...extra].filter((t) => typeof t === "string" && t.trim() !== "")) {
    // Case-insensitive; escape regex metacharacters in the brand/header string.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // eslint-disable-next-line security/detect-non-literal-regexp -- `escaped` is regex-sanitized above; the source (brand/header) is generator-produced manifest data, not user input.
    out = out.replace(new RegExp(escaped, "gi"), " PROVIDER ");
  }
  return out;
}

/** Word tokens of the normalized text. */
export function tokens(text) {
  const n = normalize(text);
  return n === "" ? [] : n.split(" ");
}

/** Neutralized shingle set for a page entry ({ text, name?, header? }). */
function pageShingles(page) {
  return wordShingles(neutralize(page.text, page.name, page.header ? [page.header] : []));
}

/** The set of k-word shingles (5-grams). A page with fewer than k words yields the single all-word shingle. */
export function wordShingles(text, k = SHINGLE_K) {
  const t = tokens(text);
  const set = new Set();
  if (t.length === 0) return set;
  if (t.length < k) {
    set.add(t.join(" "));
    return set;
  }
  for (let i = 0; i + k <= t.length; i++) set.add(t.slice(i, i + k).join(" "));
  return set;
}

/** Jaccard similarity of two shingle sets. Two empty sets ⇒ 0 (no shared substance). */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Pages whose body is below the substance floor. */
export function checkThinContent(
  pages,
  { minWords = MIN_BODY_WORDS, minShingles = MIN_UNIQUE_SHINGLES } = {},
) {
  const thin = [];
  for (const p of pages) {
    const wordCount = tokens(p.text).length;
    // Unique substance is measured on the NEUTRALIZED text: a page that is all boilerplate + a
    // repeated brand name has little genuinely-distinct content, and this reflects that.
    const shingleCount = pageShingles(p).size;
    if (wordCount < minWords || shingleCount < minShingles) {
      thin.push({ id: p.id, wordCount, shingleCount, minWords, minShingles });
    }
  }
  return thin;
}

/** All page pairs whose Jaccard similarity meets/exceeds the threshold. */
export function findNearDuplicates(pages, threshold = NEAR_DUP_JACCARD) {
  const sets = pages.map((p) => ({ id: p.id, shingles: pageShingles(p) }));
  const dups = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const score = jaccard(sets[i].shingles, sets[j].shingles);
      if (score >= threshold)
        dups.push({ a: sets[i].id, b: sets[j].id, score: Number(score.toFixed(4)) });
    }
  }
  return dups;
}

/**
 * Analyze the whole page estate. FLOOR: a non-array or EMPTY page list THROWS — the guard must never
 * report "clean" having inspected nothing. Returns { thin, nearDuplicates }.
 */
export function analyzePages(pages, opts = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("content-dup-guard: refusing to analyze an empty page set (fail-closed floor)");
  }
  for (const p of pages) {
    if (typeof p?.id !== "string" || typeof p?.text !== "string") {
      throw new Error(
        `content-dup-guard: malformed page entry ${JSON.stringify(p)?.slice(0, 120)}`,
      );
    }
  }
  return {
    thin: checkThinContent(pages, opts),
    nearDuplicates: findNearDuplicates(pages, opts.threshold),
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────────
// Returns the process exit code: 0 = clean, 1 = fail. `manifestPaths`/`coverageDirs` are injectable
// for tests; the isMain block discovers the committed fragments and checks them against the real
// shipped estate on disk.
export function run(manifestPaths = null, coverageDirs = null) {
  let pages;
  try {
    const paths =
      manifestPaths === null
        ? discoverFragments()
        : Array.isArray(manifestPaths)
          ? manifestPaths
          : [manifestPaths];
    pages = loadManifests(paths);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  // Coverage runs BEFORE the floor: a truncated manifest would otherwise pass every quantity check
  // the guard has and print "all above the substance floor" over a set that excludes the failures.
  // ON by default — a caller opts out with an explicit `false`, never by omission.
  if (coverageDirs !== false) {
    try {
      const missing = checkCoverage(pages, coverageDirs ?? {});
      if (missing.length > 0) {
        console.error(
          `content-dup-guard: ${missing.length} shipped page(s) absent from the manifest — regenerate it:`,
        );
        for (const id of missing) console.error(`  - ${id}`);
        return 1;
      }
    } catch (e) {
      console.error(e.message);
      return 1;
    }
  }
  let result;
  try {
    result = analyzePages(pages); // throws on empty/degenerate → real failure, not a pass
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  let failed = false;
  if (result.thin.length > 0) {
    failed = true;
    console.error(`content-dup-guard: ${result.thin.length} thin page(s):`);
    for (const t of result.thin)
      console.error(
        `  - ${t.id}: ${t.wordCount} words / ${t.shingleCount} shingles (need ≥${t.minWords} / ≥${t.minShingles})`,
      );
  }
  if (result.nearDuplicates.length > 0) {
    failed = true;
    console.error(
      `content-dup-guard: ${result.nearDuplicates.length} near-duplicate pair(s) (Jaccard ≥ ${NEAR_DUP_JACCARD}):`,
    );
    for (const d of result.nearDuplicates) console.error(`  - ${d.a} ≈ ${d.b}  (${d.score})`);
  }
  if (failed) return 1;
  console.log(
    `content-dup-guard: ${pages.length} pages — 0 near-duplicates, all above the substance floor.`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(run());
}
