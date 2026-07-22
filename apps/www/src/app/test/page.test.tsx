import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MARKETING_ROUTES } from "@/lib/routes";
import { mockMatchMedia } from "@/lib/test-utils";
import { TUTORIALS, tutorialPath } from "@/lib/tutorials";
import { axeComponent } from "@/test/axe";

import TestHubPage, { metadata } from "./page";

// The hub exists to solve ONE measurable problem: before it, all sixteen /test/<slug> pages had zero
// inbound internal links anywhere on the site — reachable only from a search result or by typing the
// URL. A sitemap row is not discoverability. So the load-bearing assertion here is the completeness
// one: every published tutorial is linked, derived from TUTORIALS rather than hand-listed, because a
// hand-listed hub is exactly how the seventeenth tutorial would go orphaned again.

describe("/test hub", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links to EVERY published tutorial, by name and exact href", () => {
    render(<TestHubPage />);
    const index = screen.getByRole("navigation", { name: /all providers/i });

    expect(TUTORIALS.length).toBeGreaterThan(10); // non-vacuity floor
    for (const t of TUTORIALS) {
      const link = within(index).getByRole("link", { name: new RegExp(`\\b${t.name}\\b`, "i") });
      expect(link).toHaveAttribute("href", tutorialPath(t.slug));
    }
  });

  it("links no MORE than the published tutorials — no dangling entries", () => {
    render(<TestHubPage />);
    const index = screen.getByRole("navigation", { name: /all providers/i });
    const hrefs = within(index)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));

    expect([...hrefs].sort()).toEqual(TUTORIALS.map((t) => tutorialPath(t.slug)).sort());
  });

  it("renders exactly one h1", () => {
    render(<TestHubPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("points at the two sibling tools, so the hub is a junction and not a dead end", () => {
    render(<TestHubPage />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/verify");
    expect(hrefs).toContain("/play");
  });

  // The winners for "webhook testing" / "webhook tester" are hybrids: an index/tool first, substance
  // beneath. The grid is the index and it must stay the top of the page — the added how-to and FAQ go
  // strictly BELOW it, so the hub reads as a hub, not an article with links buried at the bottom.
  it("keeps the provider grid ABOVE every added substance block", () => {
    const { container } = render(<TestHubPage />);
    const grid = screen.getByRole("navigation", { name: /all providers/i });
    // Both blocks the refit adds — the how-to section AND the FAQ — must sit after the grid, so the
    // page stays a hub. Pinning only one would let the other drift above the grid unnoticed.
    for (const selector of ["#how-it-works", "#faq"]) {
      const block = container.querySelector(selector);
      expect(block, `the hub must carry ${selector} beneath the grid`).not.toBeNull();
      expect(
        grid.compareDocumentPosition(block!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${selector} must come AFTER the provider grid, never above it`,
      ).toBeTruthy();
    }
  });

  it("emits FAQPage JSON-LD built from the questions it renders", () => {
    const { container } = render(<TestHubPage />);
    const faqLd = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent!.replace(/\\u003c/g, "<")))
      .find((j) => j["@type"] === "FAQPage");
    expect(faqLd, "the hub must publish FAQPage JSON-LD").toBeDefined();
    const questions = faqLd.mainEntity.map((q: { name: string }) => q.name).join(" | ");
    expect(questions, "the FAQ must answer the localhost-reachability question").toMatch(
      /localhost|without deploying|reach my (machine|laptop)/i,
    );
  });

  it("is registered in the route manifest as an indexable page", () => {
    const row = MARKETING_ROUTES.find((r) => r.path === "/test");
    expect(row).toBeDefined();
    expect(row!.sitemap).toBe(true);
    expect(row!.a11y).toBe(true);
  });

  it("carries a canonical and an SEO-budgeted title/description", () => {
    expect(metadata.alternates?.canonical).toBe("/test");
    expect(String(metadata.title).length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<TestHubPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
