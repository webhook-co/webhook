import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";
import { LINKS } from "@/lib/links";

import { Nav } from "./nav";
import { NAV_LINKS, REPO_LINK } from "./nav-links";

/**
 * THE GAP THIS EXISTS FOR: the site is open source and the navigation said so nowhere. `LINKS.openSource`
 * appeared in exactly one place a reader could reach — a small mark in the footer — plus three legal
 * pages. A visitor who never scrolls to the bottom left without knowing there is a repo, and the repo
 * measured four unique visitors in a fortnight.
 *
 * Every comparable does the opposite: Infisical and Trigger.dev both put the repo link inside the
 * header `<nav>`, Svix carries it in a nav dropdown, and webhook.site runs a live star-count widget.
 *
 * These tests pin the mark's PRESENCE and its TARGET. The target is the load-bearing half — the docs
 * footer shipped for months pointing at the org page, `github.com/webhook-co`, which is a bare repo
 * list nobody can star. A nav mark that makes the same mistake would be decoration.
 *
 * The mobile half is guarded by `mobile-nav.test.tsx` via `ALL_NAV_DESTINATIONS`, which `REPO_LINK` is
 * a member of — so the desktop bar and the phone menu cannot drift apart.
 */
describe("Nav: the repo mark", () => {
  it("offers the repo from the desktop bar", () => {
    render(<Nav />);
    const nav = screen.getByRole("navigation", { name: /main/i });
    expect(within(nav).getByRole("link", { name: REPO_LINK.label })).toHaveAttribute(
      "href",
      REPO_LINK.href,
    );
  });

  it("points at the REPO, not the org — an org page cannot be starred", () => {
    // `github.com/webhook-co` renders a repo list. The star button lives on the repo, so a link that
    // stops at the org spends the click and returns nothing. This is the exact defect the docs footer
    // shipped with.
    expect(REPO_LINK.href).toBe(LINKS.openSource);
    expect(REPO_LINK.href).toBe("https://github.com/webhook-co/webhook");
  });

  it("carries no star count while the count would read zero", () => {
    // A nav element announcing "0" is worse than no element: it converts a neutral visit into a
    // negative signal, and it is the one thing every star playbook warns about at cold start. Ship the
    // plain mark; the count becomes an asset only once it is one.
    render(<Nav />);
    const nav = screen.getByRole("navigation", { name: /main/i });
    const mark = within(nav).getByRole("link", { name: REPO_LINK.label });
    expect(mark.textContent ?? "").not.toMatch(/\d/);
  });

  it("still offers every text destination alongside it", () => {
    // Non-vacuous: proves the mark was added to the bar rather than replacing what was there.
    render(<Nav />);
    const nav = screen.getByRole("navigation", { name: /main/i });
    expect(NAV_LINKS.length).toBeGreaterThan(0);
    for (const { label, href } of NAV_LINKS) {
      expect(within(nav).getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Nav />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
