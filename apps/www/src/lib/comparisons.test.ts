// @vitest-environment node
// (node, not jsdom: the content-dup guard resolves its manifest path from `import.meta.url` at import
// time, and under jsdom that is not a file: URL. Same reason `tutorials.test.ts` does it.)
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain-JS guard module; imported so this test uses the SAME similarity code CI runs.
import {
  findNearDuplicates,
  jaccard,
  MIN_BODY_WORDS,
  neutralize,
  tokens,
  wordShingles,
} from "../../../../scripts/content-dup-guard.mjs";
import {
  COMPARISONS,
  comparisonPath,
  comparisonText,
  getComparison,
  RELATED_COUNT,
  relatedComparisons,
} from "@/lib/comparisons";
import { MARKETING_ROUTES } from "@/lib/routes";

// Every one of these pages names a competitor and makes factual claims about them. That is a legal
// surface, not a stylistic one, so the checks below are load-bearing:
//
//   * the near-duplicate check is the difference between four comparison pages and four doorway
//     pages. A prose TEMPLATE filled with per-competitor facts measures 0.91 on this guard — over the
//     0.8 reject line — because the guard neutralizes brand names before comparing. Here we neutralize
//     BOTH names (theirs and ours): a comparison page has two brand tokens, and leaving one in would
//     let a template score artificially low and sail through.
//   * every competitive claim must carry a source and a date, because a claim we cannot point at is a
//     claim we cannot defend.
//   * the forbidden-claims list is the same honesty gate the product and tutorial pages already pass.

/** Both brand tokens, so the guard measures STRUCTURE and not which company is being written about. */
const neutralizeBoth = (c: (typeof COMPARISONS)[number]) =>
  neutralize(comparisonText(c), c.name, ["webhook.co", "wbhk"]);

describe("comparisons: the estate", () => {
  it("publishes at least one comparison (zero-input floor)", () => {
    expect(COMPARISONS.length).toBeGreaterThan(0);
  });

  it("no two comparisons are near-duplicates of each other", () => {
    const pages = COMPARISONS.map((c) => ({
      id: `www:${c.slug}`,
      name: c.name,
      header: "webhook.co",
      text: comparisonText(c),
    }));
    const dups = findNearDuplicates(pages);
    expect(
      dups,
      `near-duplicate comparisons — these were written to a template rather than authored: ${JSON.stringify(dups)}`,
    ).toEqual([]);
  });

  // The shared guard rejects at 0.8, which is far too lenient to catch a comparison estate written to
  // a template: a published estate that IS a template measures ~0.5 pairwise, and a genuinely
  // per-competitor one measures ~0.2. So this estate is held to its own, much stricter line. At the
  // time of writing it measures 0.005 — the headroom is deliberate, and if a new page lands anywhere
  // near this threshold it was written to the shape of its siblings rather than to its own argument.
  it("keeps sibling pages structurally distinct, well inside the shared guard's line", () => {
    const shingles = (c: (typeof COMPARISONS)[number]) =>
      wordShingles(neutralize(comparisonText(c), c.name, ["webhook.co", "wbhk"]));
    for (let i = 0; i < COMPARISONS.length; i++) {
      for (let j = i + 1; j < COMPARISONS.length; j++) {
        const a = COMPARISONS[i]!;
        const b = COMPARISONS[j]!;
        const score = jaccard(shingles(a), shingles(b));
        expect(
          score,
          `${a.slug} and ${b.slug} share too much structure (${score.toFixed(3)})`,
        ).toBeLessThan(0.25);
      }
    }
  });

  // Distinctness comes from each page having its own argument, not from prose variation. If two pages
  // ever carry the same section list they are one page with the noun swapped, and no similarity score
  // will necessarily catch it — the headings could differ while the shape is identical.
  it("gives every comparison its own set of sections", () => {
    const shapes = COMPARISONS.map((c) => c.sections.map((s) => s.id).join("|"));
    expect(new Set(shapes).size, "two comparisons share a section list").toBe(shapes.length);
  });

  it("each comparison carries enough authored substance to stand on its own", () => {
    for (const c of COMPARISONS) {
      const words = tokens(neutralizeBoth(c)).length;
      expect(words, `${c.slug} has only ${words} words of authored prose`).toBeGreaterThanOrEqual(
        MIN_BODY_WORDS,
      );
    }
  });

  it("gives every comparison a route-manifest row, so it is sitemapped, SEO-checked and axe-scanned", () => {
    const paths = new Set(MARKETING_ROUTES.map((r) => r.path));
    expect(paths.has("/vs")).toBe(true);
    for (const c of COMPARISONS) {
      expect(paths.has(comparisonPath(c.slug)), `${c.slug} has no route-manifest row`).toBe(true);
    }
  });

  // A claim about another company with no source is the one a reader cannot check — and the first
  // thing that makes them doubt every other claim on the page.
  it("sources every comparison-table row that states a fact about them", () => {
    for (const c of COMPARISONS) {
      const ids = new Set(c.sources.map((s) => s.id));
      for (const row of c.table) {
        expect(
          ids.has(row.sourceId),
          `${c.slug}: table row "${row.label}" cites unknown source "${row.sourceId}"`,
        ).toBe(true);
      }
    }
  });

  it("dates every source, and points it at the competitor's own domain or ours", () => {
    for (const c of COMPARISONS) {
      expect(c.sources.length, `${c.slug} cites no sources`).toBeGreaterThan(0);
      for (const s of c.sources) {
        expect(s.url, `${c.slug}: ${s.id}`).toMatch(/^https:\/\//);
        // ISO date, so "checked on" is machine-checkable and a stale page reads as stale.
        expect(s.checked, `${c.slug}: ${s.id} has no check date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  // The page must say when it was last verified, in the copy, where a reader sees it.
  it("stamps every comparison with the date its claims were last verified", () => {
    for (const c of COMPARISONS) {
      expect(c.verifiedOn, `${c.slug}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const newest = c.sources
        .map((s) => s.checked)
        .sort()
        .at(-1);
      expect(c.verifiedOn, `${c.slug}: verifiedOn predates its own newest source`).toBe(newest);
    }
  });

  // Honest framing is the whole product here. A page that only lists where we win is an advert.
  it("says plainly where the other product is the better choice", () => {
    for (const c of COMPARISONS) {
      const words = tokens(c.chooseThem.body).length;
      expect(words, `${c.slug} concedes only ${words} words`).toBeGreaterThanOrEqual(40);
    }
  });

  it("never publishes a claim the repo cannot back", () => {
    // Same list the product and tutorial pages are held to, plus the two the comparison estate is
    // most likely to reach for. SSO and the certifications are deliberately absent from these pages
    // entirely: `scripts/no-unverified-claims.mjs` matches them regardless of whose product they
    // describe, and they are rows we would lose anyway.
    const FORBIDDEN =
      /SOC 2|ISO 27001|HIPAA|PCI|SAML|\bSSO\b|single sign-on|guaranteed delivery|never lose an event|100% (uptime|delivery)|trusted by|free, permanent|zero-knowledge|\bunlimited\b/i;
    for (const c of COMPARISONS) {
      const surfaces = [comparisonText(c), c.title, c.description, c.h1];
      for (const text of surfaces) {
        expect(text, `${c.slug} publishes a forbidden claim: ${text.slice(0, 90)}`).not.toMatch(
          FORBIDDEN,
        );
      }
    }
  });

  it("keeps titles and descriptions inside the budget a SERP actually renders", () => {
    for (const c of COMPARISONS) {
      expect(c.title.length, `${c.slug} title is ${c.title.length} chars`).toBeLessThanOrEqual(60);
      expect(c.description.length, `${c.slug} description`).toBeGreaterThanOrEqual(70);
      expect(c.description.length, `${c.slug} description`).toBeLessThanOrEqual(160);
      // The root layout appends the brand, so a title that repeats it renders it twice.
      expect(c.title).not.toMatch(/webhook\.co/);
    }
  });

  it("resolves a known slug and refuses an unknown one", () => {
    expect(getComparison(COMPARISONS[0]!.slug)?.slug).toBe(COMPARISONS[0]!.slug);
    expect(getComparison("not-a-competitor")).toBeUndefined();
  });

  it("builds member paths under the hub", () => {
    for (const c of COMPARISONS) {
      expect(comparisonPath(c.slug)).toBe(`/vs/${c.slug}`);
    }
  });

  // A wrapping window over a fixed order, so inbound sibling links are uniform BY CONSTRUCTION rather
  // than by luck — measured, not assumed. This is what stops the last page added being a leaf.
  it("links siblings uniformly, and never links a page to itself", () => {
    const inbound = new Map(COMPARISONS.map((c) => [c.slug, 0]));
    for (const c of COMPARISONS) {
      const related = relatedComparisons(c.slug);
      expect(related.map((r) => r.slug)).not.toContain(c.slug);
      expect(new Set(related.map((r) => r.slug)).size).toBe(related.length);
      for (const r of related) inbound.set(r.slug, (inbound.get(r.slug) ?? 0) + 1);
    }
    const counts = [...inbound.values()];
    expect(Math.min(...counts)).toBe(Math.max(...counts));
    expect(Math.min(...counts)).toBe(Math.min(RELATED_COUNT, COMPARISONS.length - 1));
  });

  // FAQPage JSON-LD is emitted from these strings. Two identical questions anywhere on the site ship
  // two competing FAQ entities; markdown in an answer ships as literal asterisks in the schema.
  it("asks each FAQ question once, and answers in plain text", () => {
    const seen = new Set<string>();
    for (const c of COMPARISONS) {
      for (const item of c.faq) {
        const key = item.question.trim().toLowerCase();
        expect(seen.has(key), `duplicate FAQ question: ${item.question}`).toBe(false);
        seen.add(key);
        expect(item.answer, `${c.slug}: markup in an FAQ answer`).not.toMatch(/[*`#<>]|\[.*\]\(/);
      }
    }
  });
});
