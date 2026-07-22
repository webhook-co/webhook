// @vitest-environment node
// (node, not jsdom: this file resolves the manifest path from `import.meta.url`, and under jsdom
// that is not a file: URL — the same trap tutorials.test.ts documents.)
/* eslint-disable security/detect-non-literal-fs-filename -- all paths are fixed module-relative URLs (import.meta.url), never user input. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";
import { describe, expect, it } from "vitest";

import { TUTORIALS, tutorialText } from "./tutorials";

// The www half of the content-dup-guard's estate.
//
// The guard exists to compare a docs `/providers/{slug}` reference against its www `/test/{slug}`
// tutorial — its header comment says so, and ADR-0129 §1 calls that comparison "the only backstop"
// because there is no cross-domain rel=canonical. It could never run: the manifest held docs pages
// only, so a cross-host pair was never a pair.
//
// Each host emits its own fragment because a package may not reach into an app for its data; the
// guard merges them into ONE analysis set, which is what makes the cross-host pair comparable.
//
// `tutorials.ts` records that templated tutorial prose measures 0.91 Jaccard against its siblings —
// over the 0.8 reject line — while individually-authored prose measures far below it. That was a
// measurement taken once, by hand, and enforced by nothing. Emitting these entries makes it a
// standing check.

const R = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const MANIFEST = R("scripts/generated/www-pages.json");
const ROUTES_DIR = R("apps/www/src/app/test");
const WRITE = process.env.WEBHOOK_WWW_PAGES_WRITE === "1";

/** Format exactly as `prettier --check .` would, so format-check stays green AND drift stays stable. */
const fmt = (source: string) =>
  prettier.format(source, {
    parser: "json",
    printWidth: 100,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
  });

async function buildManifest(): Promise<string> {
  // Zero-input floor: an empty tutorial set would emit an empty fragment. Fail where it is legible.
  if (TUTORIALS.length === 0) throw new Error("no tutorials found — refusing to emit an empty set");
  const pages = [...TUTORIALS]
    .map((t) => ({
      id: `www:${t.slug}`,
      host: "www",
      path: `/test/${t.slug}`,
      intent: "tutorial",
      // The brand token the guard neutralizes before shingling. Tutorials carry no signature header,
      // so `header` is empty — the guard skips empty neutralization tokens.
      name: t.name,
      header: "",
      // Deliberately the authored prose only. The shared capture/listen/replay copy the tutorial
      // component renders is identical on all sixteen pages by design; feeding it to a similarity
      // check would drag every pair toward every other and invert the guard it feeds.
      text: tutorialText(t),
    }))
    // Code-unit order, NOT localeCompare: this file is byte-pinned by the drift test below, and
    // ICU collation orders `_` against `-`/digits differently from code units (the estate already has
    // `atlassian_jira`, `ms_teams`). A locale-dependent sort would red on one machine and pass on another.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return await fmt(JSON.stringify({ pages }, null, 2));
}

describe("www tutorial pages — the www half of the dup-guard estate", () => {
  it("has tutorials to emit (zero-input floor)", () => {
    expect(TUTORIALS.length).toBeGreaterThan(0);
  });

  if (WRITE) {
    it("writes the www dup-guard manifest fragment", async () => {
      if (!existsSync(R("scripts/generated")))
        mkdirSync(R("scripts/generated"), { recursive: true });
      writeFileSync(MANIFEST, await buildManifest());
      expect(existsSync(MANIFEST)).toBe(true);
    });
    return;
  }

  it("the committed fragment matches a fresh build", async () => {
    expect(
      existsSync(MANIFEST),
      "the www dup-guard fragment is missing — run `pnpm --filter @webhook-co/www gen:pages-manifest`",
    ).toBe(true);
    expect(
      readFileSync(MANIFEST, "utf8"),
      "the www dup-guard fragment is stale — run `pnpm --filter @webhook-co/www gen:pages-manifest`",
    ).toBe(await buildManifest());
  });

  // Checked against the ROUTE TREE, not against TUTORIALS. TUTORIALS is what the builder reads, so
  // comparing the manifest back to it can only fail if the drift test above already has — it would
  // restate that test with a friendlier message rather than verify anything independently.
  it("the fragment matches the routes that actually ship, in both directions", () => {
    const routes = readdirSync(ROUTES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ROUTES_DIR, d.name, "page.tsx")))
      .map((d) => d.name);
    expect(routes.length, "no /test/* routes found — refusing to pass vacuously").toBeGreaterThan(
      0,
    );

    const covered = new Set(
      (JSON.parse(readFileSync(MANIFEST, "utf8")).pages as { path: string }[]).map((p) =>
        p.path.slice("/test/".length),
      ),
    );
    expect(
      routes.filter((r) => !covered.has(r)).sort(),
      "routes that ship but are absent from the dup-guard manifest",
    ).toEqual([]);
    // The reverse direction, which nothing else covers: a TUTORIALS entry whose route directory was
    // never created would otherwise enter the manifest as a page that does not exist.
    expect(
      [...covered].filter((c) => !routes.includes(c)).sort(),
      "manifest entries with no /test/* route on disk",
    ).toEqual([]);
  });
});
