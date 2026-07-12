import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { MobileNav } from "./mobile-nav";
import { ALL_NAV_DESTINATIONS } from "./nav-links";

// THE BUG THIS EXISTS FOR: the desktop nav is `max-[940px]:hidden` and for a while there was nothing
// behind it — below 940px the site had a logo and a "Get started" button and NO way to reach Product,
// Pricing, About or Docs. It shipped to production that way, because every Playwright project was
// `Desktop Chrome`: the a11y suite had never once rendered a phone.
//
// These tests pin the behaviour. The VIEWPORT is guarded separately, by the mobile Playwright project
// — a jsdom test can't tell you whether the burger is actually visible at 375px.

describe("MobileNav", () => {
  it("offers EVERY destination the desktop nav does — the two must not drift", async () => {
    // The whole point of a shared nav-links source. If someone adds a page to the desktop bar and
    // forgets the mobile menu, phone users silently lose it. That is exactly how this bug happened.
    render(<MobileNav />);
    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));

    const nav = screen.getByRole("navigation", { name: /main/i });
    expect(ALL_NAV_DESTINATIONS.length).toBeGreaterThan(4); // non-vacuous
    for (const { label, href } of ALL_NAV_DESTINATIONS) {
      expect(within(nav).getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it("is a disclosure: the trigger owns the panel and reports its state", async () => {
    render(<MobileNav />);
    const trigger = screen.getByRole("button", { name: /open menu/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls");

    await userEvent.click(trigger);
    expect(screen.getByRole("button", { name: /close menu/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(<MobileNav />);
    const trigger = screen.getByRole("button", { name: /open menu/i });
    await userEvent.click(trigger);

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /open menu/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // A panel you dismiss with the keyboard must hand focus back, or the reader is dropped at the
    // top of the document.
    expect(screen.getByRole("button", { name: /open menu/i })).toHaveFocus();
  });

  it("closes when a link is followed (the panel must not sit over the new page)", async () => {
    render(<MobileNav />);
    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    await userEvent.click(screen.getByRole("link", { name: "Pricing" }));
    expect(screen.getByRole("button", { name: /open menu/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the links in the DOM while collapsed — the static export must carry them", () => {
    // The site is a static export; the nav shouldn't depend on hydration to exist for a crawler or a
    // reader with JS off. Hidden, not unmounted.
    const { container } = render(<MobileNav />);
    const panel = container.querySelector("[hidden]")!;
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getAllByRole("link", { hidden: true }).length).toBe(
      ALL_NAV_DESTINATIONS.length + 1, // + the "Get started" CTA
    );
  });

  it("has no accessibility violations, open or closed", async () => {
    const { container } = render(<MobileNav />);
    expect(await axeComponent(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
