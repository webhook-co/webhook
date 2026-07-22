import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { axeComponent } from "@/test/axe";
import { COMPARISONS, comparisonPath } from "@/lib/comparisons";
import { installIntersectionObserverMock, mockMatchMedia } from "@/lib/test-utils";

import { ComparisonPage } from "./comparison-page";

const fixture = COMPARISONS[0]!;

function renderPage(c = fixture) {
  mockMatchMedia(true);
  installIntersectionObserverMock();
  return render(<ComparisonPage comparison={c} />);
}

afterEach(() => vi.unstubAllGlobals());

describe("ComparisonPage", () => {
  it("renders exactly one h1, naming both products", () => {
    renderPage();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(fixture.h1);
  });

  // A comparison page's claims decay. A reader who cannot see when it was last checked has to assume
  // the worst, and an undated claim about another company is the one we would least like to defend.
  it("shows the date the claims were last verified, in the copy", () => {
    const { container } = renderPage();
    expect(container.textContent).toContain(fixture.verifiedOn);
  });

  it("renders every authored section as a labelled region with a real heading", () => {
    const { container } = renderPage();
    for (const section of fixture.sections) {
      const heading = container.querySelector(`#${section.id}`);
      expect(heading, `section ${section.id} did not render`).not.toBeNull();
      expect(heading).toHaveTextContent(section.heading);
      expect(container.querySelector(`[aria-labelledby="${section.id}"]`)).not.toBeNull();
    }
  });

  // The concession is the load-bearing wall: every other claim on the page is believable only because
  // this one is here. Pinned so a future tidy-up cannot quietly drop it.
  it("renders the concession section in full", () => {
    const { container } = renderPage();
    expect(container.textContent).toContain(fixture.chooseThem.heading);
    expect(container.textContent).toContain(fixture.chooseThem.body);
  });

  it("renders every table row with both sides filled in", () => {
    renderPage();
    const table = screen.getByRole("table");
    for (const row of fixture.table) {
      const cell = within(table).getByRole("rowheader", { name: row.label });
      const cells = within(cell.closest("tr") as HTMLElement).getAllByRole("cell");
      expect(cells.map((c) => c.textContent)).toEqual([row.them, row.us]);
    }
  });

  // A wide table is how a page ships that scrolls the whole document sideways on a phone. It must
  // scroll inside its own box — and a scrollable region needs a name and keyboard reach, or axe is
  // right to complain about it.
  it("puts the table in a named, keyboard-reachable scroll container", () => {
    renderPage();
    const scroller = screen.getByRole("region", { name: /comparison table/i });
    expect(scroller).toHaveAttribute("tabindex", "0");
    expect(within(scroller).getByRole("table")).toBeInTheDocument();
  });

  // Every fact we state about them must be one click from their own page saying it.
  it("lists every source as a real outbound link, with its check date", () => {
    const { container } = renderPage();
    const sources = container.querySelector("#sources")?.closest("section");
    expect(sources).not.toBeNull();
    for (const source of fixture.sources) {
      const link = within(sources as HTMLElement).getByRole("link", { name: source.label });
      expect(link).toHaveAttribute("href", source.url);
    }
    expect(sources?.textContent).toContain(fixture.sources[0]!.checked);
  });

  // Scoped to <main> deliberately. The footer's Compare column legitimately links the top comparisons
  // on every page of the site, including this one — a self-link in the chrome is not a defect, and the
  // orphan guard discounts self-links anyway. What must not happen is the page's own sibling strip
  // offering the reader a link back to the page they are already on.
  it("links back to the hub and on to its siblings, never to itself", () => {
    renderPage();
    const main = screen.getByRole("main");
    const hrefs = within(main)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/vs");
    expect(hrefs).not.toContain(comparisonPath(fixture.slug));
    expect(hrefs.some((h) => h.startsWith("/vs/"))).toBe(true);
  });

  it("emits FAQPage structured data built from the questions it renders", () => {
    const { container } = renderPage();
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const parsed = JSON.parse(script!.textContent!) as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    expect(parsed.mainEntity.map((e) => e.name)).toEqual(fixture.faq.map((f) => f.question));
    expect(parsed.mainEntity[0]!.acceptedAnswer.text).toBe(fixture.faq[0]!.answer);
  });

  it("ships no link that goes nowhere", () => {
    const { container } = renderPage();
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href"), "a comparison link with no destination").toBeTruthy();
    }
  });

  it("resolves every in-page anchor it renders", () => {
    const { container } = renderPage();
    for (const a of container.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute("href")!.slice(1);
      expect(container.querySelector(`#${id}`), `dangling anchor #${id}`).not.toBeNull();
    }
  });

  it("composes without axe violations, for every published comparison", async () => {
    for (const comparison of COMPARISONS) {
      const { container, unmount } = renderPage(comparison);
      expect(await axeComponent(container), comparison.slug).toHaveNoViolations();
      unmount();
    }
  }, 60000);
});
