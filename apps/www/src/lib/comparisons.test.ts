// @vitest-environment node
// (node, not jsdom: the content-dup guard resolves its manifest path from `import.meta.url` at import
// time, and under jsdom that is not a file: URL. Same reason `tutorials.test.ts` does it.)
// @ts-expect-error -- plain-JS guard module; the tests use the SAME rules `pnpm lint` runs,
// rather than a paraphrase that drifts the moment the real list moves.
import { CLAIM_RULES } from "../../../../scripts/no-unverified-claims.mjs";
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
  FORBIDDEN_CLAIMS,
  getComparison,
  RELATED_COUNT,
  relatedComparisons,
} from "@/lib/comparisons";
import { MARKETING_ROUTES } from "@/lib/routes";
import { DELIVERY_MAX_ATTEMPTS } from "@webhook-co/shared";
import { FREE_EVENT_CAP, planById } from "@webhook-co/shared/plans";
import { PROVIDERS } from "@webhook-co/webhooks-spec";

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
  // a template, so this estate is held to a much stricter line of its own.
  //
  // The line is set from MEASUREMENT, not taste. This estate measures 0.005 pairwise on the guard's
  // 5-gram shingles with both brand names neutralised. A fifth page assembled by reusing a sibling's
  // prose verbatim scores 0.152 at 25% reuse, 0.251 at 40% and 0.304 at 50% — so a 0.25 ceiling would
  // let a page that copy-pasted a third of its sibling ship green. 0.05 still leaves 10x headroom over
  // the real signal while catching roughly 10% reuse, which is the point at which a page has stopped
  // being written and started being assembled.
  it("keeps sibling pages structurally distinct, well inside the shared guard's line", () => {
    const shingles = (c: (typeof COMPARISONS)[number]) => wordShingles(neutralizeBoth(c));
    for (let i = 0; i < COMPARISONS.length; i++) {
      for (let j = i + 1; j < COMPARISONS.length; j++) {
        const a = COMPARISONS[i]!;
        const b = COMPARISONS[j]!;
        const score = jaccard(shingles(a), shingles(b));
        expect(
          score,
          `${a.slug} and ${b.slug} share too much structure (${score.toFixed(3)})`,
        ).toBeLessThan(0.05);
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

  // A duplicate DOM id is caught today only by `check-anchors.mjs`, which runs after a full build.
  // These ids come from data, so a collision — either between two sections, or with an id the shared
  // shell already emits — should fail in milliseconds instead.
  it("keeps every section id unique within its page, and clear of the shell's own ids", () => {
    // Emitted by comparison-page.tsx for every comparison, plus the ids the Faq component owns.
    const SHELL_IDS = new Set([
      "why",
      "at-a-glance",
      "choose-them",
      "choose-us",
      "migration",
      "sources",
      "more-comparisons",
      "faq",
      "faq-heading",
      "main",
    ]);
    for (const c of COMPARISONS) {
      const ids = c.sections.map((s) => s.id);
      expect(new Set(ids).size, `${c.slug} repeats a section id`).toBe(ids.length);
      for (const id of ids) {
        expect(SHELL_IDS.has(id), `${c.slug}: section id "${id}" collides with a shell id`).toBe(
          false,
        );
      }
    }
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

  // The name used to promise a domain check this body did not perform, which is worse than having no
  // check at all — it is the reason nobody adds the real one. Now it performs it.
  it("dates every source and points it at a primary domain, never a third party", () => {
    // Their own domains, ours, and the Wayback Machine — the last only because the original
    // requestb.in pages it preserves are dead, which is itself the claim being sourced.
    const PRIMARY = [
      "ngrok.com",
      "webhook.site",
      "docs.webhook.site",
      "hookdeck.com",
      "status.hookdeck.com",
      "api.hookdeck.com",
      "github.com",
      "pipedream.com",
      "web.archive.org",
      "webhook.co",
    ];
    for (const c of COMPARISONS) {
      expect(c.sources.length, `${c.slug} cites no sources`).toBeGreaterThan(0);
      for (const s of c.sources) {
        expect(s.url, `${c.slug}: ${s.id}`).toMatch(/^https:\/\//);
        const host = new URL(s.url).hostname;
        expect(
          PRIMARY.some((d) => host === d || host.endsWith(`.${d}`)),
          `${c.slug}: ${s.id} cites ${host}, which is not a primary source`,
        ).toBe(true);
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

  // Nothing forced `verifiedOn` forward, so the estate could quietly become the thing it opens by
  // mocking — "most comparison pages you will find about ngrok are repeating a version of it that no
  // longer exists". This is the mechanism that stops that. It WILL fail one day and be annoying to
  // fix; going and re-reading four competitors' pricing pages twice a year is the actual job.
  it("refuses to publish claims nobody has re-read in six months", () => {
    const MAX_AGE_DAYS = 180;
    const today = new Date("2026-07-22T00:00:00Z"); // fixed: a clock-dependent test is a flake
    for (const c of COMPARISONS) {
      const age = (today.getTime() - new Date(`${c.verifiedOn}T00:00:00Z`).getTime()) / 86_400_000;
      expect(
        age,
        `${c.slug} was last verified ${Math.round(age)} days ago — re-read its sources and bump verifiedOn`,
      ).toBeLessThan(MAX_AGE_DAYS);
    }
  });

  // A length floor, and only a length floor. It cannot tell a real concession from filler — no
  // automated check can — so it is here to stop the section being quietly emptied, not to certify
  // that it is honest. The honesty is a human review job, which is why this lane ends in one.
  it("keeps a non-trivial concession section on every comparison", () => {
    for (const c of COMPARISONS) {
      const words = tokens(c.chooseThem.body).length;
      expect(words, `${c.slug} concedes only ${words} words`).toBeGreaterThanOrEqual(40);
    }
  });

  it("never publishes a claim the repo cannot back", () => {
    for (const c of COMPARISONS) {
      // The TABLE is included deliberately. `comparisonText()` excludes it — correctly, because the
      // near-duplicate guard must not see boilerplate — and for a while that meant the honesty gate
      // could not see the single most-read element on the page. An adversarial review proved it: a
      // page whose table read "SOC 2 Type II certified" and "guaranteed delivery, 100% uptime"
      // passed every check in this file. It does not now.
      const surfaces = [comparisonText(c), JSON.stringify(c.table), c.title, c.description, c.h1];
      for (const text of surfaces) {
        expect(text, `${c.slug} publishes a forbidden claim`).not.toMatch(FORBIDDEN_CLAIMS);
        // The REAL gate's rules, not a paraphrase of them. `pnpm lint` runs these over the rendered
        // source; running them over the authored strings here fails in milliseconds instead of after
        // a full lint, and cannot drift from the list CI enforces.
        for (const rule of CLAIM_RULES as { id: string; re: RegExp }[]) {
          expect(text, `${c.slug} trips the ${rule.id} claim rule`).not.toMatch(rule.re);
        }
      }
    }

    // Non-vacuous: both lists must still be able to fire. A regex that matched nothing would make
    // every assertion above pass for any content at all.
    expect("unlimited events on every plan").toMatch(FORBIDDEN_CLAIMS);
    const ids = (CLAIM_RULES as { id: string; re: RegExp }[]).filter((r) =>
      r.re.test("we hold SOC 2 certification and offer SAML single sign-on"),
    );
    expect(ids.length, "CLAIM_RULES stopped matching a claim it exists to catch").toBeGreaterThan(
      0,
    );
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

  // A true number written as a literal is just a number that hasn't rotted yet — the same reasoning
  // `provider-count.test.ts` already applies to the homepage's one "141 providers" sentence. This
  // estate adds eight more copies of that number plus prices, retention windows, the free cap and the
  // retry count, every one of which has a canonical source. Pinned here so adding the 142nd adapter,
  // or repricing Pro, names the sentences to change instead of quietly making four public pages lie.
  //
  // Scoped to the `us` column deliberately: 141 also legitimately describes a COMPETITOR elsewhere in
  // this file (Hookdeck documents 141 named platforms), so a whole-file regex would pin the wrong
  // number to the wrong company.
  it("pins every provider count on our side of the table to the registry", () => {
    let checked = 0;
    for (const c of COMPARISONS) {
      for (const row of c.table) {
        const claimed = row.us.match(/\b(\d+)\s+providers\b/);
        if (!claimed) continue;
        checked += 1;
        expect(
          Number(claimed[1]),
          `${c.slug}: table says ${claimed[1]} providers, registry has ${PROVIDERS.length}`,
        ).toBe(PROVIDERS.length);
      }
    }
    expect(checked, "no provider-count row found — re-point this test").toBeGreaterThan(0);
  });

  it("pins the provider count in the prose too", () => {
    let checked = 0;
    for (const c of COMPARISONS) {
      // Match EVERY "<n> providers" in the prose and exclude the competitor sentences explicitly,
      // rather than including ours by accident of which verb precedes it — reword "we ship it for
      // 141 providers" to "across 141 providers" and a verb-keyed regex silently stops looking.
      for (const m of comparisonText(c).matchAll(
        /\b(\d+)\s+(?:named third-party platforms|providers)\b/g,
      )) {
        const sentence = comparisonText(c).slice(Math.max(0, m.index! - 90), m.index! + 40);
        const isAboutThem =
          sentence.includes(c.name) || /their|they|documentation lists/i.test(sentence);
        if (isAboutThem) continue;
        checked += 1;
        expect(Number(m[1]), `${c.slug} prose claims ${m[1]} providers`).toBe(PROVIDERS.length);
      }
    }
    expect(checked, "no provider-count prose found — re-point this test").toBeGreaterThan(0);
  });

  it("pins our prices, free allowance, retention and retry count to their catalogs", () => {
    const pro = planById("pro")!;
    const scale = planById("scale")!;
    const free = planById("free")!;
    const everything = COMPARISONS.map((c) => comparisonText(c) + JSON.stringify(c.table)).join(
      " ",
    );

    // Price: `packages/shared/src/plans.ts` is the one catalog, and it exists so a price can never
    // disagree across surfaces. If Pro is repriced, this fails and names the file to edit.
    expect(everything, "a price on a /vs page no longer matches the plan catalog").toContain(
      `${pro.price}/month`,
    );
    // …and no OTHER euro-per-month figure may appear, so a hand-typed price cannot slip in beside
    // the pinned one.
    for (const m of everything.matchAll(/€(\d+)\/month/g)) {
      expect([pro.price, scale.price], `unpinned price €${m[1]}/month`).toContain(`€${m[1]}`);
    }

    // Free allowance and retention windows.
    expect(everything).toContain(FREE_EVENT_CAP.toLocaleString("en-US"));
    expect(everything).toContain(`${free.retentionDays} days Free`);
    expect(everything).toContain(`${pro.retentionDays} Pro`);
    expect(everything).toContain(`${scale.retentionDays} Scale`);
    expect(everything).toContain(`${scale.retentionDays} days on Scale`);

    // Retry count.
    expect(everything).toContain(`${DELIVERY_MAX_ATTEMPTS} attempts`);
  });

  // Before status.webhook.co shipped, the Hookdeck comparison conceded on four surfaces that we had no
  // status page. We publish one now (LINKS.status, footer-linked), so every one of those concessions is
  // a published falsehood. Contractual uptime/latency commitments are STILL genuinely Hookdeck's — our
  // own terms disclaim any uptime commitment — so that concession stays. The correction narrows the
  // claim; it does not trade one false row for another.
  it("corrects the stale status-page concession without over-claiming on uptime", () => {
    const hd = getComparison("hookdeck")!;
    const prose = comparisonText(hd);

    // Corrected positively: we acknowledge we publish a status page too.
    expect(prose, "the corrected status-page acknowledgment is missing").toMatch(
      /we publish a status page too/i,
    );
    // None of the four stale concessions may remain.
    expect(prose, "where-they-are-ahead still says 'we publish neither'").not.toMatch(
      /we publish neither/i,
    );
    expect(prose, "chooseThem still lists 'the status page,' among their advantages").not.toMatch(
      /the status page,/i,
    );
    expect(prose, "the FAQ still lists a status page among their maturity markers").not.toMatch(
      /publish a status page and/i,
    );
    for (const row of hd.table) {
      if (/status page/i.test(row.label)) {
        expect(row.us, `table row "${row.label}" still concedes no status page`).not.toMatch(
          /^\s*no\.?\s*$/i,
        );
      }
    }

    // The concession that is still TRUE stays, conceded plainly: no contractual uptime/latency
    // commitment on our side. Dropping it entirely would over-correct in the other direction.
    const uptimeRow = hd.table.find((r) =>
      /uptime and latency commitment|contractual .*commitment/i.test(r.label),
    );
    expect(uptimeRow, "the contractual-commitment concession was dropped entirely").toBeDefined();
    expect(uptimeRow!.us).toMatch(/^\s*no\.?\s*$/i);
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
