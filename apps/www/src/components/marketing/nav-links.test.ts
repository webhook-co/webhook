import { describe, expect, it } from "vitest";

import { LINKS } from "@/lib/links";

import { ALL_NAV_DESTINATIONS, RESOURCE_LINKS } from "./nav-links";

// The comparison estate goes UNDER Resources rather than getting its own top-level menu. Resources is
// already "the things you can use to evaluate us without an account", and a top-level "Compare" item
// would tell every first-time visitor — including the ones who have never heard of a competitor — that
// we define ourselves relative to other products. That is a positioning cost paid on every page view
// to serve visitors who arrive from a search engine, on a comparison page, already mid-evaluation.
//
// The rule that matters more than the placement: the chrome links the HUB, never a competitor slug.
// Sixteen tutorial slugs in the footer would have been link-stuffing and would have orphaned the
// seventeenth; the same arithmetic applies here, and the comparison set is the one most likely to grow.
describe("nav-links: the comparison estate", () => {
  it("offers the comparison hub in the Resources menu", () => {
    expect(RESOURCE_LINKS.map((l) => [l.label, l.href])).toContainEqual([
      "Comparisons",
      LINKS.comparisons,
    ]);
  });

  it("points that entry at the hub, not at a competitor page", () => {
    expect(LINKS.comparisons).toBe("/vs");
  });

  it("never enumerates an individual comparison in the navigation", () => {
    const deeper = ALL_NAV_DESTINATIONS.filter((l) => l.href.startsWith("/vs/"));
    expect(deeper, "the nav must link the /vs hub, never its members").toEqual([]);
  });

  it("keeps Resources a menu a reader can scan — six entries at most", () => {
    // The constraint the old footer comment named: past roughly six, a column stops being scannable.
    // Pinned so growth is forced through the hub instead of through this list.
    expect(RESOURCE_LINKS.length).toBeLessThanOrEqual(6);
  });
});
