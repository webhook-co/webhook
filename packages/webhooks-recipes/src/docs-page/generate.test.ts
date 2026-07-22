/* eslint-disable security/detect-non-literal-fs-filename -- all paths are fixed module-relative URLs (import.meta.url), never user input. */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { describe, expect, it } from "vitest";
import { getRecipe } from "../index";
import { CURATED } from "./curated";
import { manifestEntry, sidebarTitle } from "./manifest";
import { withProviderPages } from "./nav";
import { renderProviderPage } from "./render";

const R = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const PROVIDERS_DIR = R("apps/docs/providers");
const DOCS_JSON = R("apps/docs/docs.json");
const MANIFEST = R("scripts/generated/programmatic-pages.json");
const WRITE = process.env.WEBHOOK_DOCS_WRITE === "1";

const SLUGS = Object.keys(CURATED).sort();

/** Format exactly as `prettier --check .` would, so format-check stays green AND drift stays stable. */
const fmt = (source: string, parser: "mdx" | "json") =>
  prettier.format(source, {
    parser,
    printWidth: 100,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
  });

async function buildPages(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const slug of SLUGS) {
    const recipe = getRecipe(slug);
    if (!recipe) throw new Error(`curated entry "${slug}" has no recipe in the registry`);
    const { icon, ...curated } = CURATED[slug]!;
    const mdx = renderProviderPage({ recipe, displayName: curated.displayName, icon, curated });
    out.set(slug, await fmt(mdx, "mdx"));
  }
  return out;
}

const entryFor = (slug: string, mdx: string) =>
  manifestEntry({
    slug,
    // Brand token to neutralize before shingling. Curated pages know their display name; a
    // hand-authored one declares it as `sidebarTitle`. Falling back to the slug would leave the brand
    // un-neutralized and make two same-shaped pages look artificially distinct.
    displayName: CURATED[slug]?.displayName ?? sidebarTitle(mdx) ?? slug,
    signatureHeader: getRecipe(slug)?.signatureHeader ?? null,
    mdx,
  });

/**
 * The manifest holds every provider page that SHIPS — generated and hand-authored alike — enumerated
 * from disk rather than from `CURATED`.
 *
 * It used to hold only what this template emits. The reasoning was sound at the time and is recorded
 * in ADR-0129 §4: the hand-authored pages were below the substance floor, so carrying them would have
 * meant exempting them, i.e. relaxing a live gate. That precondition is gone — those pages now clear
 * the floor on their own content — so the exclusion goes with it, and no threshold moves.
 *
 * Scoping the set to the generator's own output is what made the gap self-concealing: the floor
 * applied to exactly the pages that could never fail it. Enumerating the directory instead means a new
 * page is picked up automatically, the committed manifest goes stale, and the drift test below reds
 * until it is regenerated. A page cannot ship without entering the guard.
 *
 * There is no exclusion list. `directory`, `custom` and `verifying-provider-webhooks` are provider-
 * estate pages too and clear the floor comfortably; an exclusion list is a hole that rots.
 */
/** The on-disk path for a slug, preferring `.mdx` and falling back to `.md`. */
const pagePath = (slug: string) =>
  existsSync(`${PROVIDERS_DIR}/${slug}.mdx`)
    ? `${PROVIDERS_DIR}/${slug}.mdx`
    : `${PROVIDERS_DIR}/${slug}.md`;

async function buildManifest(generated: Map<string, string>): Promise<string> {
  // `.md` as well as `.mdx`: docs-nav-guard treats both as pages and content-dup-guard's coverage
  // check globs both. A narrower predicate here would let lint discover a page this generator can
  // never emit — red, with no remedy.
  const slugs = readdirSync(PROVIDERS_DIR)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => f.replace(/\.mdx?$/, ""))
    .sort();
  // Zero-input floor: an empty enumeration would emit an empty manifest, which the guard would then
  // have to catch. Fail here, at the point the mistake is legible.
  if (slugs.length === 0) throw new Error("no provider pages found in apps/docs/providers");
  const pages = slugs.map((slug) =>
    entryFor(slug, generated.get(slug) ?? readFileSync(pagePath(slug), "utf8")),
  );
  return await fmt(JSON.stringify({ pages }, null, 2), "json");
}

describe("provider docs pages — generated from the registry, drift-pinned", () => {
  it("generates a page for every curated provider (zero-input floor)", () => {
    expect(SLUGS.length).toBeGreaterThan(0);
  });

  if (WRITE) {
    it("writes the pages, the nav, and the dup-guard manifest", async () => {
      const generated = await buildPages();
      for (const [slug, mdx] of generated) writeFileSync(`${PROVIDERS_DIR}/${slug}.mdx`, mdx);

      const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
      writeFileSync(
        DOCS_JSON,
        await fmt(JSON.stringify(withProviderPages(docs, SLUGS), null, 2), "json"),
      );

      if (!existsSync(R("scripts/generated")))
        mkdirSync(R("scripts/generated"), { recursive: true });
      writeFileSync(MANIFEST, await buildManifest(generated));
      expect(generated.size).toBe(SLUGS.length);
    });
    return;
  }

  it("every committed page is byte-identical to a fresh render (no hand-edits, no drift)", async () => {
    for (const [slug, mdx] of await buildPages()) {
      const path = `${PROVIDERS_DIR}/${slug}.mdx`;
      expect(
        existsSync(path),
        `${slug}.mdx is missing — run pnpm --filter @webhook-co/webhooks-recipes gen:docs`,
      ).toBe(true);
      expect(readFileSync(path, "utf8"), `${slug}.mdx drifted from the registry`).toBe(mdx);
    }
  });

  it("every generated page is wired into the docs nav (docs-nav-guard would red otherwise)", () => {
    const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
    const nav = new Set<string>();
    for (const tab of docs.navigation.tabs)
      for (const g of tab.groups ?? []) for (const p of g.pages ?? []) nav.add(p);
    for (const slug of SLUGS)
      expect(nav.has(`providers/${slug}`), `providers/${slug} is not in the nav`).toBe(true);
  });

  it("the committed dup-guard manifest matches a fresh build", async () => {
    expect(existsSync(MANIFEST)).toBe(true);
    expect(
      readFileSync(MANIFEST, "utf8"),
      "the dup-guard manifest is stale — run `pnpm --filter @webhook-co/webhooks-recipes gen:docs`",
    ).toBe(await buildManifest(await buildPages()));
  });

  it("every curated block cites the provider's own documentation", () => {
    for (const slug of SLUGS) {
      const c = CURATED[slug]!;
      expect(c.sourceUrl, `${slug} has no sourceUrl`).toMatch(/^https:\/\//);
      expect(c.where.trim().length, `${slug} has no "where" prose`).toBeGreaterThan(0);
    }
  });

  // `credentialKind` decides whether the page says "public key" or "signing secret" — in the prose, the
  // description, and the env-var name in the copy-paste snippet. It is hand-written, so without this it
  // is a free-text field that can contradict the engine: setting Discord to "secret" renders "Register
  // your Discord signing secret" and `$DISCORD_SIGNING_SECRET` for what is actually Discord's Ed25519
  // PUBLIC key, and every other gate stays green. Bind it to the archetype the registry reports.
  it("the credential kind matches the recipe's archetype (a public key is never called a secret)", () => {
    for (const slug of SLUGS) {
      const isAsymmetric = getRecipe(slug)!.archetype === "asymmetric";
      expect(
        CURATED[slug]!.credentialKind === "public-key",
        `${slug}: credentialKind must be ${isAsymmetric ? '"public-key"' : '"secret"'} to match its ${getRecipe(slug)!.archetype} recipe`,
      ).toBe(isAsymmetric);
    }
  });
  // COVERAGE. The manifest's page set must be "what ships", not "what this template emits". These
  // assertions are deliberately derived from sources the manifest BUILDER does not use — the
  // filesystem and the committed nav — because "the builder enumerated correctly" is precisely the
  // assumption that failed before: the floor applied to seven generated pages while ten hand-authored
  // ones, seven of them below it, were invisible to the guard entirely.
  const docsManifestSlugs = (): Set<string> => {
    const pages = JSON.parse(readFileSync(MANIFEST, "utf8")).pages as {
      host: string;
      path: string;
    }[];
    return new Set(
      pages.filter((p) => p.host === "docs").map((p) => p.path.replace("/providers/", "")),
    );
  };

  it("the manifest covers every provider page on disk (zero-input floor: the dir is non-empty)", () => {
    const onDisk = readdirSync(PROVIDERS_DIR)
      .filter((f) => /\.mdx?$/.test(f))
      .map((f) => f.replace(/\.mdx?$/, ""));
    expect(onDisk.length, "no provider pages found — refusing to pass vacuously").toBeGreaterThan(
      0,
    );
    const covered = docsManifestSlugs();
    expect(
      onDisk.filter((s) => !covered.has(s)).sort(),
      "provider pages that ship but are absent from the dup-guard manifest",
    ).toEqual([]);
  });

  it("the manifest and the docs nav agree exactly on the published provider set", () => {
    const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
    const nav = new Set<string>();
    for (const tab of docs.navigation.tabs)
      for (const g of tab.groups ?? [])
        for (const p of g.pages ?? [])
          if (typeof p === "string" && p.startsWith("providers/"))
            nav.add(p.slice("providers/".length));
    expect(
      nav.size,
      "no providers/* nav entries found — refusing to pass vacuously",
    ).toBeGreaterThan(0);
    const covered = docsManifestSlugs();
    expect(
      [...nav].filter((s) => !covered.has(s)).sort(),
      "nav entries missing from the manifest",
    ).toEqual([]);
    expect(
      [...covered].filter((s) => !nav.has(s)).sort(),
      "manifest entries the nav does not publish",
    ).toEqual([]);
  });

  // A hand-authored page is NOT drift-pinned to the engine — that protection exists only for the
  // generated seven. So bind the facts a reader would act on to what the registry reports. This is a
  // presence check, not a proof the prose is right: it cannot tell two pages apart that share a
  // header (github and meta do). What it DOES catch is rot — change the algorithm, the encoding or
  // the header in the engine and every page still claiming the old value goes red, instead of
  // quietly becoming false while every other gate stays green. That is the `credentialKind` lesson
  // from ADR-0129 §2 applied to hand-authored pages.
  it("a hand-authored page's stated mechanics match what the engine implements", () => {
    const handAuthored = readdirSync(PROVIDERS_DIR)
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => f.replace(/\.mdx$/, ""))
      .filter((slug) => !(slug in CURATED));
    expect(handAuthored.length, "no hand-authored pages found").toBeGreaterThan(0);

    // The exemption is where the scrutiny belongs: pages with no registry recipe are skipped below,
    // so pin that set exactly. A typo'd or retired slug must not quietly join it.
    expect(
      handAuthored.filter((slug) => !getRecipe(slug)).sort(),
      "non-provider pages exempt from the mechanics check",
    ).toEqual(["custom", "directory", "verifying-provider-webhooks"]);

    let checked = 0;
    for (const slug of handAuthored) {
      const recipe = getRecipe(slug);
      if (!recipe) continue;
      const mdx = readFileSync(`${PROVIDERS_DIR}/${slug}.mdx`, "utf8").toLowerCase();

      // The **Algorithm** bullet, specifically — not "somewhere in the file".
      const algorithmBullet = /^-\s+\*\*algorithm\*\*\s+—\s+(.+)$/m.exec(mdx)?.[1] ?? "";
      expect(
        algorithmBullet,
        `${slug}.mdx has no "**Algorithm** — …" bullet to check against the registry`,
      ).not.toBe("");
      expect(
        algorithmBullet.startsWith(
          `${recipe.algorithm.toLowerCase()}, ${recipe.encoding.toLowerCase()}-encoded`,
        ),
        `${slug}.mdx's Algorithm bullet must open with "${recipe.algorithm}, ${recipe.encoding}-encoded" — found "${algorithmBullet.slice(0, 60)}"`,
      ).toBe(true);

      if (recipe.signatureHeader) {
        // Word-anchored: a bare `includes` for `x-hub-signature` would be satisfied by the text
        // `x-hub-signature-256`, so narrowing the registry header would go undetected.
        const header = recipe.signatureHeader.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(
          new RegExp(`(?<![a-z0-9-])${header}(?![a-z0-9-])`).test(mdx),
          `${slug}.mdx must name the header the engine reads (${recipe.signatureHeader})`,
        ).toBe(true);
      } else {
        // The signature travels in the body. Naming an `x-…-signature` header would send the reader
        // to look for something the engine never reads for this provider.
        expect(
          /x-[a-z0-9-]*(signature|hmac)[a-z0-9-]*/.exec(mdx)?.[0] ?? null,
          `${slug}.mdx signs in the body, so it must not name a signature header`,
        ).toBeNull();
      }
      checked++;
    }
    // Zero-input floor: a filter bug that checked nothing must not read as a pass.
    expect(checked, "no provider pages were actually checked").toBeGreaterThan(0);
  });
});
