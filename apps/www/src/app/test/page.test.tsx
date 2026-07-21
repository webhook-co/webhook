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
