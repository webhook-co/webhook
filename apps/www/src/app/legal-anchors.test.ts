import { describe, expect, it } from "vitest";

// The built-HTML checker keeps its own copy of the anchor list (it runs on the emitted out/, with no
// TypeScript). Two copies of a contract is one too many unless something forces them to agree.
import { REQUIRED_ANCHORS } from "../../scripts/check-anchors.mjs";

import { LEGAL_ANCHORS, type LegalRoute } from "./legal-anchors";

/**
 * The FROZEN contract. Hand-maintained, never generated from the source — generating it would make
 * it agree with any change, which is the one thing it must not do.
 *
 * Every id here may be cited in an executed agreement or a vendor security questionnaire. Adding a
 * section is free. **Removing or renaming one is a breaking change to a URL we do not control the
 * other end of** — so do not "fix" a failure here by editing this list. Leave the old id in place as
 * an alias target and add the new one.
 */
const GOLDEN: Record<LegalRoute, readonly string[]> = {
  terms: [
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
  privacy: [
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
  dpa: [
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
  "acceptable-use": [
    "scope",
    "why-this-is-strict",
    "prohibited-uses",
    "regulated-data",
    "monitoring",
    "enforcement",
    "reporting-abuse",
    "changes",
  ],
  "sub-processors": ["current-sub-processors", "changes"],
};

/** Lowercase, hyphen-separated, no leading/trailing/doubled hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const routes = Object.keys(LEGAL_ANCHORS) as LegalRoute[];

describe.each(routes)("/%s anchors", (route) => {
  const ids = Object.values(LEGAL_ANCHORS[route]) as string[];

  // A SUPERSET check, on purpose. Adding a section must not fail; removing or renaming one must.
  // That is exactly the discrimination we want: reword a heading freely, break a citation never.
  it("still carries every anchor ever published (append-only)", () => {
    const missing = GOLDEN[route].filter((id) => !ids.includes(id));
    expect(
      missing,
      `/${route}: these anchors were REMOVED or RENAMED. They are cited in signed agreements and ` +
        `security questionnaires — the links are already out in the world and will now land at the ` +
        `top of the page. Add an alias target instead of renaming.`,
    ).toEqual([]);
  });

  // A duplicate id is two bugs at once: an a11y violation, and a deep link that silently resolves to
  // whichever section happens to come first.
  it("has no duplicate ids", () => {
    expect(new Set(ids).size, `/${route}: duplicate anchor id`).toBe(ids.length);
  });

  it("uses well-formed slugs", () => {
    for (const id of ids) {
      expect(id, `/${route}: "${id}" is not a clean slug`).toMatch(SLUG);
    }
  });

  // The whole reason we hand-assign ids rather than slugging the heading text: our headings are
  // numbered, and legal edits renumber them. A positional id would break on every insertion.
  it("uses no positional ids — renumbering a clause must never break a citation", () => {
    for (const id of ids) {
      expect(id, `/${route}: "${id}" starts with a number — anchors must be semantic`).not.toMatch(
        /^\d/,
      );
    }
  });

  // The build-time checker asserts these ids actually rendered into out/. If its copy of the list
  // drifts from this one, it quietly stops checking the anchors that were added since.
  it("is mirrored exactly by the built-HTML checker", () => {
    expect(
      REQUIRED_ANCHORS[`${route}.html`],
      `scripts/check-anchors.mjs is out of sync for /${route}`,
    ).toEqual(ids);
  });
});
