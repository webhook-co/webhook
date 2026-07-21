/* eslint-disable security/detect-non-literal-fs-filename -- all paths are fixed module-relative URLs (import.meta.url), never user input. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { describe, expect, it } from "vitest";
import { getRecipe } from "../index";
import { CURATED } from "./curated";
import { manifestEntry } from "./manifest";
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
    displayName: CURATED[slug]?.displayName ?? slug,
    signatureHeader: getRecipe(slug)?.signatureHeader ?? null,
    mdx,
  });

/**
 * The manifest holds exactly what this generator emits — nothing else. CI's `content-dup-guard` reads
 * it and applies its substance floor to every entry, unmodified, so the set must be pages whose length
 * this generator controls. Adding the hand-written pages here would have meant exempting them from that
 * floor, i.e. weakening the gate to accommodate content this lane does not own.
 *
 * That still leaves the comparison worth having: two GENERATED pages must not duplicate each other.
 * Calendly and Zoom are excluded from CURATED for exactly that reason — rendered through this template
 * they score 0.95 against Stripe and Slack — and if those are ever generated too, the guard catches the
 * pair here rather than relying on anyone remembering.
 */
async function buildManifest(generated: Map<string, string>): Promise<string> {
  const pages = [...generated].map(([slug, mdx]) => entryFor(slug, mdx));
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
});
