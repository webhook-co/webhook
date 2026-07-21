// @vitest-environment node
// (node, not jsdom: the guard module resolves its manifest path from `import.meta.url` at import
// time, and under jsdom that is not a file: URL.)
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain-JS guard module; imported so this test uses the SAME similarity code CI runs.
import {
  findNearDuplicates,
  MIN_BODY_WORDS,
  neutralize,
  tokens,
} from "../../../../scripts/content-dup-guard.mjs";
import { FAQ_ITEMS } from "@/components/marketing/faq";
import { HOME_FAQ_ITEMS } from "@/components/marketing/home-faq";
import { MARKETING_ROUTES } from "@/lib/routes";
import { TUTORIALS, tutorialPath, tutorialText } from "@/lib/tutorials";

// These pages are the reason the lane exists, and every one of them is a set of public claims. The
// checks below are the difference between "sixteen useful pages" and "sixteen doorway pages": the
// near-duplicate assertion in particular is not a formality — a prose TEMPLATE filled with real
// per-provider facts measures 0.91 here, over the guard's 0.8 reject line, because the guard
// neutralizes the brand name before comparing. Only genuinely individual writing passes.

describe("provider tutorials", () => {
  it("publishes at least one tutorial (zero-input floor)", () => {
    expect(TUTORIALS.length).toBeGreaterThan(0);
  });

  it("no two tutorials are near-duplicates of each other", () => {
    const pages = TUTORIALS.map((t) => ({
      id: `www:${t.slug}`,
      name: t.name,
      header: "",
      text: tutorialText(t),
    }));
    const dups = findNearDuplicates(pages);
    expect(
      dups,
      `near-duplicate tutorials — these were written to a template rather than authored: ${JSON.stringify(dups)}`,
    ).toEqual([]);
  });

  it("each tutorial carries enough authored substance to stand on its own", () => {
    for (const t of TUTORIALS) {
      const words = tokens(neutralize(tutorialText(t), t.name, [])).length;
      expect(words, `${t.slug} has only ${words} words of authored prose`).toBeGreaterThanOrEqual(
        MIN_BODY_WORDS,
      );
    }
  });

  it("every tutorial has a route-manifest row, so it is sitemapped, SEO-checked and axe-scanned", () => {
    const paths = new Set(MARKETING_ROUTES.map((r) => r.path));
    for (const t of TUTORIALS) {
      expect(
        paths.has(tutorialPath(t.slug)),
        `${tutorialPath(t.slug)} is missing from MARKETING_ROUTES`,
      ).toBe(true);
    }
  });

  it("no FAQ question is asked twice anywhere on the site", () => {
    // Duplicate FAQPage entities across URLs is the failure mode; every question must be unique
    // against the pricing FAQ, the homepage FAQ, and every other tutorial.
    const seen = new Map<string, string>();
    for (const item of FAQ_ITEMS) seen.set(item.question, "/pricing");
    for (const item of HOME_FAQ_ITEMS) seen.set(item.question, "/");
    for (const t of TUTORIALS) {
      for (const item of t.faq) {
        const where = seen.get(item.question);
        expect(where, `"${item.question}" is already answered on ${where}`).toBeUndefined();
        seen.set(item.question, tutorialPath(t.slug));
      }
    }
  });

  it("FAQ questions name their provider, which is what keeps them distinct", () => {
    for (const t of TUTORIALS) {
      for (const item of t.faq) {
        expect(item.question, `"${item.question}" does not name ${t.name}`).toContain(t.name);
      }
    }
  });

  it("FAQ answers are plain text — they are emitted as JSON-LD, not rendered as markdown", () => {
    for (const t of TUTORIALS) {
      for (const item of t.faq) {
        expect(item.answer, `${t.slug}: "${item.question}"`).not.toMatch(/[*_`#[\]]|<[a-z]/i);
      }
    }
  });

  it("makes no claim the product cannot back", () => {
    const forbidden = [
      /SOC 2/i,
      /HIPAA/i,
      /SAML/i,
      /ISO 27001/i,
      /PCI/i,
      /\bcompliant\b/i,
      /real-time/i,
      /guaranteed delivery/i,
      /never lose an event/i,
      /100% /,
      /trusted by/i,
      /cryptographically verified/i,
    ];
    for (const t of TUTORIALS) {
      const text = `${tutorialText(t)} ${t.title} ${t.description} ${t.h1}`;
      for (const re of forbidden) {
        expect(text, `${t.slug} matches ${re}`).not.toMatch(re);
      }
    }
  });

  it("keeps titles and descriptions inside the SEO budget", () => {
    for (const t of TUTORIALS) {
      expect(t.title.length, `${t.slug} title is ${t.title.length} chars`).toBeLessThanOrEqual(60);
      expect(
        t.description.length,
        `${t.slug} description is ${t.description.length} chars`,
      ).toBeGreaterThanOrEqual(70);
      expect(
        t.description.length,
        `${t.slug} description is ${t.description.length} chars`,
      ).toBeLessThanOrEqual(160);
      // The root template appends the brand; repeating it wastes the pixel budget.
      expect(t.title.toLowerCase(), `${t.slug} title repeats the brand`).not.toContain(
        "webhook.co",
      );
    }
  });

  it("names real event identifiers and never an empty list", () => {
    for (const t of TUTORIALS) {
      expect(t.eventExamples.length, `${t.slug} lists no events`).toBeGreaterThan(0);
      for (const ev of t.eventExamples) {
        expect(ev.trim(), `${t.slug} has a blank event example`).not.toBe("");
        // A verbatim identifier never carries surrounding punctuation or prose.
        expect(ev, `${t.slug}: "${ev}" looks like prose, not an identifier`).not.toMatch(
          /\s|["'`]/,
        );
      }
    }
  });
});
