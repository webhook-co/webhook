import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RELATED_COUNT, relatedTutorials, type Tutorial, tutorialPath } from "@/lib/tutorials";
import { TutorialPage } from "./tutorial-page";

const fixture: Tutorial = {
  slug: "example",
  name: "Example",
  title: "Test Example webhooks locally",
  description: "Point Example at a capture URL, watch events arrive, replay them into localhost.",
  h1: "Test Example webhooks locally",
  lede: "Capture what Example actually sends, then replay it into your handler.",
  distinctive: "Example refuses to deliver until the endpoint answers its handshake.",
  configure: "Register the URL under the developer settings area.",
  fireTest: "There is no test button; perform the real action.",
  eventsIntro: "Example names events with a dot.",
  eventExamples: ["thing.created", "thing.deleted"],
  gotchas: [
    { heading: "It retries for an hour", body: "Failed deliveries are retried for an hour." },
  ],
  faq: [{ question: "Does Example retry failed webhooks?", answer: "Yes, for an hour." }],
};

describe("TutorialPage", () => {
  it("renders exactly one h1 — the Playwright suites wait on it and axe requires it", () => {
    const { container } = render(<TutorialPage tutorial={fixture} />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(fixture.h1);
  });

  it("renders the provider-specific prose, which is what makes the page non-duplicate", () => {
    render(<TutorialPage tutorial={fixture} />);
    for (const prose of [
      fixture.distinctive,
      fixture.configure,
      fixture.fireTest,
      fixture.eventsIntro,
    ]) {
      expect(screen.getByText(prose)).toBeTruthy();
    }
  });

  it("renders every event example verbatim", () => {
    render(<TutorialPage tutorial={fixture} />);
    for (const ev of fixture.eventExamples) expect(screen.getByText(ev)).toBeTruthy();
  });

  it("renders each gotcha with its own subheading", () => {
    render(<TutorialPage tutorial={fixture} />);
    expect(screen.getByRole("heading", { name: fixture.gotchas[0]!.heading })).toBeTruthy();
    expect(screen.getByText(fixture.gotchas[0]!.body)).toBeTruthy();
  });

  it("emits FAQPage structured data built from the same items it renders", () => {
    const { container } = render(<TutorialPage tutorial={fixture} />);
    const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
    const faqLd = scripts
      .map((s) => JSON.parse(s.textContent!.replace(/\\u003c/g, "<")))
      .find((j) => j["@type"] === "FAQPage");
    expect(faqLd, "the page must publish FAQPage JSON-LD").toBeDefined();
    expect(faqLd.mainEntity[0].name).toBe(fixture.faq[0]!.question);
  });

  it("emits a per-provider HowTo whose steps mirror the visible tutorial", () => {
    // A tutorial IS a how-to (create → point → trigger → replay), so it is marked up as one. The two
    // middle steps are the provider-specific `configure`/`fireTest` prose the page renders, which is
    // what keeps sixteen HowTos from being sixteen clones — and keeps the markup matching the page.
    const { container } = render(<TutorialPage tutorial={fixture} />);
    const howTo = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent!.replace(/\\u003c/g, "<")))
      .find((j) => j["@type"] === "HowTo");
    expect(howTo, "the tutorial must publish HowTo JSON-LD").toBeDefined();
    expect(howTo.name).toMatch(new RegExp(fixture.name, "i"));
    expect(howTo.step.length, "a HowTo needs the whole loop").toBeGreaterThanOrEqual(3);
    const stepTexts = howTo.step.map((s: { text: string }) => s.text);
    expect(stepTexts, "the configure step must carry the page's own configure prose").toContain(
      fixture.configure,
    );
    expect(stepTexts, "the trigger step must carry the page's own fireTest prose").toContain(
      fixture.fireTest,
    );
    // And every step's text must actually be visible on the page — the schema may not out-run the DOM.
    for (const text of stepTexts) {
      expect(container.textContent, `HowTo step text not on the page: ${text}`).toContain(text);
    }
  });

  it("renders the CLI commands with their spacing intact", () => {
    // This shipped once as "$wbhk listen": JSX drops the whitespace around a child that wraps onto a
    // second source line, and prettier chooses where that wrap falls, so the bug appears at format
    // time rather than when the line is written. Assert the rendered text, not the source.
    const { container } = render(<TutorialPage tutorial={fixture} />);
    const terminal = container.textContent ?? "";
    expect(terminal).toContain("$ wbhk endpoints create example-dev");
    expect(terminal).toContain(
      "$ wbhk listen <endpoint-id> --forward http://localhost:3000/webhooks",
    );
    expect(terminal).toContain("$ wbhk replay <event-id> --forward http://localhost:3000/webhooks");
    expect(terminal, "a prompt fused to its command means JSX ate the space").not.toMatch(/\$wbhk/);
  });

  it("every in-page anchor resolves to a real id (check-seo-html fails the build otherwise)", () => {
    const { container } = render(<TutorialPage tutorial={fixture} />);
    for (const a of container.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute("href")!.slice(1);
      expect(id, "no bare href=# is allowed anywhere on the site").not.toBe("");
      expect(container.querySelector(`#${CSS.escape(id)}`), `#${id} has no target`).toBeTruthy();
    }
  });

  it("labels each section, so the heading structure is navigable", () => {
    const { container } = render(<TutorialPage tutorial={fixture} />);
    for (const section of container.querySelectorAll("section[aria-labelledby]")) {
      const id = section.getAttribute("aria-labelledby")!;
      expect(within(container as HTMLElement).getByText, "sanity").toBeTruthy();
      expect(
        container.querySelector(`#${CSS.escape(id)}`),
        `${id} is referenced but absent`,
      ).toBeTruthy();
    }
  });
});

// The related-providers strip. Every tutorial used to be a leaf: no link to a sibling, no link to a
// parent, so a reader who landed on one from a search result had nowhere to go but the nav. These
// assertions pin the two escape hatches — siblings and the hub — and that the strip never links the
// page back to itself.
describe("TutorialPage related links", () => {
  it("links RELATED_COUNT siblings and the hub, and never itself", () => {
    render(<TutorialPage tutorial={fixture} />);
    const strip = screen.getByRole("navigation", { name: /more providers/i });
    const hrefs = within(strip)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));

    expect(hrefs).toContain("/test");
    expect(hrefs).not.toContain(tutorialPath(fixture.slug));
    // The siblings, plus the one hub link.
    expect(hrefs).toHaveLength(RELATED_COUNT + 1);
    for (const related of relatedTutorials(fixture.slug)) {
      expect(hrefs).toContain(tutorialPath(related.slug));
    }
  });

  it("renders each sibling under its provider name, so the link text is not 'read more'", () => {
    render(<TutorialPage tutorial={fixture} />);
    const strip = screen.getByRole("navigation", { name: /more providers/i });
    for (const related of relatedTutorials(fixture.slug)) {
      expect(within(strip).getByRole("link", { name: new RegExp(related.name, "i") })).toBeTruthy();
    }
  });
});
