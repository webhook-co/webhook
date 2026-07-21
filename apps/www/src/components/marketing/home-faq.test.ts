import { describe, expect, it } from "vitest";

import { FAQ_ITEMS } from "./faq";
import { HOME_FAQ_ITEMS } from "./home-faq";

// The homepage FAQ is published as FAQPage structured data — it is the surface an answer engine can
// quote back when someone asks "what is webhook.co". That makes every answer a public claim, and a
// wrong one is worse than no answer at all: it would be repeated verbatim, by a machine, at scale.

describe("the homepage FAQ", () => {
  it("does not repeat the pricing FAQ — duplicate FAQPage schema across two URLs", () => {
    const pricing = new Set(FAQ_ITEMS.map((i) => i.question));
    for (const item of HOME_FAQ_ITEMS) {
      expect(pricing, `"${item.question}" is already answered on /pricing`).not.toContain(
        item.question,
      );
    }
    expect(HOME_FAQ_ITEMS.length).toBeGreaterThan(0); // non-vacuous
  });

  it("answers the awkward questions, not only the flattering ones", () => {
    const questions = HOME_FAQ_ITEMS.map((i) => i.question.toLowerCase()).join(" | ");
    // The two a buyer actually asks and a marketing site usually dodges.
    expect(questions).toMatch(/send webhooks|outbound|publish/); // do you do outbound? (we don't)
    expect(questions).toMatch(/testing tool|tester/); // aren't you just a webhook tester?
  });

  it("states plainly that outbound publishing is NOT shipped", () => {
    const outbound = HOME_FAQ_ITEMS.find((i) => /send webhooks to my customers/i.test(i.question));
    expect(outbound, "the outbound question must be answered").toBeDefined();
    // The whole point is the disclaimer. If someone softens this into an implied yes, fail.
    expect(outbound!.answer).toMatch(/not yet|does not/i);
    expect(outbound!.answer).not.toMatch(/coming soon|shortly|on the roadmap/i);
  });

  it("makes no claim the product can't back", () => {
    const text = HOME_FAQ_ITEMS.map((i) => `${i.question} ${i.answer}`).join(" ");
    expect(text.length).toBeGreaterThan(500); // non-vacuous: there IS copy to scan
    for (const forbidden of [
      /SOC 2/i,
      /HIPAA/i,
      /SAML/i,
      /\bcompliant\b/i,
      /real-time/i,
      /blocks? until/i, // the false agent-trigger push framing
      /free,? (and )?permanent/i,
      /cryptographically verified/i, // ~14 of the 141 are token/basic auth, not HMAC
    ]) {
      expect(text, `must not claim ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("keeps answers as plain text — they are serialised into JSON-LD, not rendered as markdown", () => {
    for (const item of HOME_FAQ_ITEMS) {
      expect(item.answer, `markdown in "${item.question}"`).not.toMatch(/[*_`#[\]]|<[a-z]/i);
    }
  });
});
