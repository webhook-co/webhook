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
  // Every behavioural assertion below used to run against COMPARISONS[0] and generalise. It doesn't:
  // a page with a section id colliding with a shell id, or an empty migration list rendering a bare
  // heading, would have shipped green. These run over the whole estate now.
  describe.each(COMPARISONS.map((c) => [c.slug, c] as const))("%s", (_slug, c) => {
    it("renders exactly one h1, naming both products", () => {
      renderPage(c);
      const h1s = screen.getAllByRole("heading", { level: 1 });
      expect(h1s).toHaveLength(1);
      expect(h1s[0]).toHaveTextContent(c.h1);
    });

    it("renders every authored section, the concession, and every migration step", () => {
      const { container } = renderPage(c);
      for (const section of c.sections) {
        expect(container.querySelector(`#${section.id}`), section.id).not.toBeNull();
        expect(container.textContent).toContain(section.body);
      }
      expect(container.textContent).toContain(c.chooseThem.body);
      expect(c.migration.length, `${c.slug} has no migration path`).toBeGreaterThan(0);
      for (const step of c.migration) expect(container.textContent).toContain(step.heading);
    });

    it("renders every table row with both sides filled in", () => {
      renderPage(c);
      const table = screen.getByRole("table");
      for (const row of c.table) {
        const header = within(table).getByRole("rowheader", { name: row.label });
        const cells = within(header.closest("tr") as HTMLElement).getAllByRole("cell");
        expect(cells.map((x) => x.textContent)).toEqual([row.them, row.us]);
      }
    });

    // B2: the most decision-relevant fact about us. It lives in the shell so it cannot be forgotten
    // on a new page — this is the assertion that makes that guarantee real.
    it("discloses that webhook.co is pre-launch", () => {
      const { container } = renderPage(c);
      expect(container.textContent).toMatch(/pre-launch/i);
      expect(container.textContent).toMatch(/published, not yet purchasable/i);
    });

    it("emits no duplicate DOM id", () => {
      const { container } = renderPage(c);
      const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes, `${c.slug} emits duplicate ids: ${dupes.join(", ")}`).toEqual([]);
    });
  });

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
    // Selected by @type, not by document position: this page emits BreadcrumbJsonLd too, and a
    // first-match-wins query would pass today only because the FAQ script happens to render first.
    const parsed = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent!) as { "@type"?: string })
      .find((node) => node["@type"] === "FAQPage") as unknown as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    expect(parsed, "no FAQPage node emitted").toBeDefined();
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
