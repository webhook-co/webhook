import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { axeComponent } from "@/test/axe";

import { NavMenus } from "./nav-menus";

function renderWithOutside() {
  return render(
    <div>
      <NavMenus />
      <button type="button">outside</button>
    </div>,
  );
}

const trigger = (name: RegExp) => screen.getByRole("button", { name });

describe("NavMenus", () => {
  it("starts closed with the links present but hidden (no-JS reachable)", () => {
    render(<NavMenus />);
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById("navmenu-product");
    expect(panel).toHaveAttribute("hidden");
    // The Product menu points at real www /product/* pages now (not docs) — the whole point of the
    // IA lane: only the top-level "Docs" link leaves for docs.webhook.co.
    expect(
      within(panel as HTMLElement).getByRole("link", { name: "Capture & replay", hidden: true }),
    ).toHaveAttribute("href", "/product/capture-replay");
  });

  it("keeps the whole Product menu on www — no item leaves for the docs subdomain", () => {
    render(<NavMenus />);
    const panel = document.getElementById("navmenu-product") as HTMLElement;
    const hrefs = within(panel)
      .getAllByRole("link", { hidden: true })
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/product/capture-replay",
      "/product/verification",
      "/product/delivery",
      "/product/agent-triggers",
    ]);
    expect(hrefs.some((h) => h?.includes("docs.webhook.co"))).toBe(false);
  });

  it("opens on click and reveals the links", async () => {
    render(<NavMenus />);
    await userEvent.click(trigger(/^product$/i));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById("navmenu-product") as HTMLElement;
    expect(panel).not.toHaveAttribute("hidden");
    expect(within(panel).getByRole("link", { name: "Delivery" })).toBeInTheDocument();
  });

  // Two disclosures, and only two: "Product" (what it does) and "Resources" (things you can use).
  // The old "Developers" dropdown — docs/quickstart/API/CLI/MCP — stays gone: those are docs
  // deep-links and they live in the footer, with the top nav carrying a single "Docs" link
  // (nav.tsx). The count is pinned so a third dropdown is a deliberate decision, not a drift.
  it("renders exactly two menus — Product and Resources — and no Developers dropdown", () => {
    render(<NavMenus />);
    expect(trigger(/^product$/i)).toBeInTheDocument();
    expect(trigger(/^resources$/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^developers$/i })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  // The Resources menu is the fix for a measured problem: the sixteen /test/<slug> tutorials shipped
  // with ZERO inbound internal links, and /play had exactly one (the homepage hero). Pinning the exact
  // hrefs means a rename that quietly drops one turns this red.
  //
  // The comparison hub joined the same menu rather than taking a third top-level dropdown. Resources
  // is already "what you can use to evaluate us without an account", which is precisely what a
  // comparison page is for; a top-level "Compare" would announce to every first-time visitor that we
  // define ourselves against other products, on every page view, to serve readers who arrive from a
  // search engine already mid-evaluation. It links the HUB — `/vs`, never `/vs/<slug>`.
  it("puts the four evaluation surfaces behind Resources, on www", () => {
    render(<NavMenus />);
    const panel = document.getElementById("navmenu-resources") as HTMLElement;
    const hrefs = within(panel)
      .getAllByRole("link", { hidden: true })
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/verify", "/test", "/play", "/vs"]);
  });

  it("opens Resources on click and reveals the tutorial hub", async () => {
    render(<NavMenus />);
    await userEvent.click(trigger(/^resources$/i));
    expect(trigger(/^resources$/i)).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById("navmenu-resources") as HTMLElement;
    expect(panel).not.toHaveAttribute("hidden");
    expect(within(panel).getByRole("link", { name: /webhook tutorials/i })).toHaveAttribute(
      "href",
      "/test",
    );
  });

  it("opens only one menu at a time", async () => {
    render(<NavMenus />);
    await userEvent.click(trigger(/^product$/i));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(trigger(/^resources$/i));
    expect(trigger(/^resources$/i)).toHaveAttribute("aria-expanded", "true");
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render(<NavMenus />);
    const product = trigger(/^product$/i);
    await userEvent.click(product);
    await userEvent.keyboard("{Escape}");
    expect(product).toHaveAttribute("aria-expanded", "false");
    expect(product).toHaveFocus();
  });

  it("closes on an outside pointer press", async () => {
    renderWithOutside();
    await userEvent.click(trigger(/^product$/i));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when focus leaves the menu", async () => {
    renderWithOutside();
    const product = trigger(/^product$/i);
    await userEvent.click(product);
    fireEvent.focusOut(product, {
      relatedTarget: screen.getByRole("button", { name: "outside" }),
    });
    expect(product).toHaveAttribute("aria-expanded", "false");
  });

  it("has no axe violations (closed and open)", async () => {
    const { container } = render(<NavMenus />);
    expect(await axeComponent(container)).toHaveNoViolations();
    await userEvent.click(trigger(/^product$/i));
    expect(await axeComponent(container)).toHaveNoViolations();
  });

  it("removes its document listeners on unmount", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<NavMenus />);
    await userEvent.click(trigger(/^product$/i));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    removeSpy.mockRestore();
  });
});
