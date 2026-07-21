#!/usr/bin/env node
// Anti-thin-content guard for the programmatic provider pages. Fails if any two SHIPPED pages are
// near-duplicates, or if any page falls below a substance floor. Wired into `pnpm lint`.
//
// WHY a manifest and not built HTML: the estate is CROSS-HOST — "how to test {provider} webhooks
// locally" tutorials on www (Next static export) AND "verify {provider} signature" references on docs
// (Mintlify, built off-repo). No single `out/` holds both, and both are generated from the SAME
// registry recipe rows, so a www tutorial can silently near-duplicate its docs reference with no
// per-host check able to see it. So the page generators (www + docs) each emit their pages' rendered
// body text into ONE committed manifest, and this guard dedupes ACROSS the whole estate.
//
// PARSE, don't scan; and a fail-closed FLOOR: analyzePages() THROWS on empty/degenerate input, and the
// runner distinguishes "manifest absent" (pages not generated yet — idle) from "manifest present but
// empty" (a real degeneracy — fail). The sibling content-dup-guard.test.mjs runs the guard on fixtures
// every CI run, so the algorithm is proven live even before pages exist.
//
// The manifest shape: { pages: [{ id, host, path, intent, text }] } where `text` is the page's
// rendered, human-visible body (markup already stripped by the generator).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/docs-lib.mjs";

// ── Tunable, named, defensible thresholds ────────────────────────────────────────
export const SHINGLE_K = 5; // word-level 5-grams
export const NEAR_DUP_JACCARD = 0.8; // ≥ this over 5-gram sets ⇒ near-duplicate
export const MIN_BODY_WORDS = 150; // a real per-provider page clears this
export const MIN_UNIQUE_SHINGLES = 40; // …and carries this much distinct 5-gram substance

// The committed manifest the page generators emit. Absent until the first pages ship (PR: www
// tutorials / docs references). Path is fixed + module-relative — never user input.
export const MANIFEST_PATH = fileURLToPath(
  new URL("./generated/programmatic-pages.json", import.meta.url),
);

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
 * BEFORE shingling. The brand name is the LEGITIMATE per-provider differentiator, so leaving it in makes
 * two same-template pages (github vs meta) look ~45% different purely because the name is swapped ~10×.
 * Neutralizing it measures the page STRUCTURE — the real thin-doorway signal — not the brand token.
 */
export function neutralize(text, name, extra = []) {
  let out = String(text);
  for (const token of [name, ...extra].filter((t) => typeof t === "string" && t.trim() !== "")) {
    // Whole-token, case-insensitive; escape regex metacharacters in the brand/header string.
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
    // The floor polices GENERATED pages: a short generated page means the template padded its way to
    // a doorway page, and that is the risk a generator introduces at scale. Hand-authored pages opt
    // out with an explicit `generated: false` — and ONLY out of this floor; they are still compared
    // for near-duplicates, which is the whole reason the manifest carries the estate and not just our
    // own output. Absence of the flag means generated, so nothing is exempted by omission.
    //
    // Being straight about what this exempts: it is not merely theoretical. Seven of the ten
    // hand-authored provider pages are currently below the word floor (110–147). Nothing regressed —
    // before the manifest existed this guard inspected zero pages — but those seven are unfixed, and
    // this line is why they do not fail. They are listed in `docs-page/curated.ts`.
    if (p.generated === false) continue;
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
// Returns the process exit code: 0 = clean/idle, 1 = fail. `manifestPath` is injectable for tests;
// the isMain block always uses the committed MANIFEST_PATH.
export function run(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    // Pre-pages state: no generator has emitted a manifest yet. Explicitly logged, never a silent
    // pass — the sibling unit test proves the guard itself works on every CI run.
    console.log(
      "content-dup-guard: no programmatic-pages manifest yet — idle (guard proven by unit tests).",
    );
    return 0;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`content-dup-guard: manifest is unreadable/invalid JSON: ${e.message}`);
    return 1;
  }
  const pages = manifest?.pages;
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
