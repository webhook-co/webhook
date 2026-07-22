import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- plain-JS guard module; the tests use the SAME rules `pnpm lint` runs, rather
// than a paraphrase of them that drifts the moment the real list moves.
import { CLAIM_RULES } from "../../../../../scripts/no-unverified-claims.mjs";

import { axeComponent } from "@/test/axe";
import { COMPARISONS, comparisonPath, FORBIDDEN_CLAIMS } from "@/lib/comparisons";
import { MARKETING_ROUTES } from "@/lib/routes";
import { installIntersectionObserverMock, mockMatchMedia } from "@/lib/test-utils";

import VsHubPage, { metadata } from "./page";

function renderHub() {
  mockMatchMedia(true);
  installIntersectionObserverMock();
  return render(<VsHubPage />);
}

afterEach(() => vi.unstubAllGlobals());

describe("/vs hub", () => {
  it("renders exactly one h1", () => {
    renderHub();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  // The hub is the ONE page the site chrome links, so it is the only thing standing between every
  // member page and being an orphan. Derived from COMPARISONS rather than hand-listed, and asserted
  // both ways: a comparison with no card here would ship unreachable, and a card for a comparison
  // that does not exist would be a dead link.
  it("links every published comparison, and nothing that is not one", () => {
    renderHub();
    const index = screen.getByRole("navigation", { name: /all comparisons/i });
    const hrefs = within(index)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs.sort()).toEqual(COMPARISONS.map((c) => comparisonPath(c.slug)).sort());
  });

  it("names each competitor in the link a reader clicks", () => {
    renderHub();
    const index = screen.getByRole("navigation", { name: /all comparisons/i });
    for (const c of COMPARISONS) {
      expect(within(index).getByRole("link", { name: new RegExp(c.name, "i") })).toHaveAttribute(
        "href",
        comparisonPath(c.slug),
      );
    }
  });

  // The most load-bearing section on the page. An estate of comparison pages with no reader it turns
  // away is an advert; this is the section that makes every other claim in the estate believable, and
  // it is the reason the hub exists as a page rather than as a bare list of links.
  it("says plainly who should not use webhook.co", () => {
    const { container } = renderHub();
    const section = container.querySelector("#not-for-you")?.closest("section");
    expect(section, "the hub must carry a disqualification section").not.toBeNull();
    // Non-vacuous, and specific: it has to NAME the tools that are a better answer, not gesture at
    // the idea of them. 400 characters of anything would have passed the length check alone.
    for (const rival of [/Hookdeck/, /ngrok/, /webhook\.site/, /Svix/]) {
      expect(section!.textContent, `the disqualification section must name ${rival}`).toMatch(
        rival,
      );
    }
  });

  it("is registered in the route manifest as an indexable, axe-scanned page", () => {
    const row = MARKETING_ROUTES.find((r) => r.path === "/vs");
    expect(row).toBeDefined();
    expect(row!.sitemap).toBe(true);
    expect(row!.a11y).toBe(true);
  });

  it("keeps its title and description inside the budget a SERP renders", () => {
    expect(metadata.title).toBeTruthy();
    expect(String(metadata.title).length).toBeLessThanOrEqual(60);
    expect(String(metadata.description).length).toBeGreaterThanOrEqual(70);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
  });

  it("publishes no claim the repo cannot back", () => {
    const { container } = renderHub();
    for (const text of [container.textContent ?? "", String(metadata.description)]) {
      expect(text).not.toMatch(FORBIDDEN_CLAIMS);
      for (const rule of CLAIM_RULES as { id: string; re: RegExp }[]) {
        expect(text, `the hub trips the ${rule.id} claim rule`).not.toMatch(rule.re);
      }
    }
  });

  it("ships no link that goes nowhere, and resolves every anchor", () => {
    const { container } = renderHub();
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
    for (const a of container.querySelectorAll('a[href^="#"]')) {
      expect(container.querySelector(`#${a.getAttribute("href")!.slice(1)}`)).not.toBeNull();
    }
  });

  it("composes without axe violations", async () => {
    const { container } = renderHub();
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 30000);
});
