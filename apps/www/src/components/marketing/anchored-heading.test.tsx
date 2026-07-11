import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { AnchoredHeading } from "./anchored-heading";

describe("AnchoredHeading", () => {
  it("renders an h2 carrying the id a deep link targets", () => {
    render(
      <AnchoredHeading id="limitation-of-liability">9. Limitation of liability</AnchoredHeading>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: /limitation of liability/i });
    expect(heading).toHaveAttribute("id", "limitation-of-liability");
  });

  it("can render an h3 for a sub-section", () => {
    render(
      <AnchoredHeading level={3} id="retention-windows">
        Retention windows
      </AnchoredHeading>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Retention windows" })).toHaveAttribute(
      "id",
      "retention-windows",
    );
  });

  // The link WRAPS the heading text, so its accessible name is the heading text itself — free, real,
  // and impossible to drift out of sync. The alternative (a bare "#" sibling link) is the classic
  // way to ship a `link-name` violation: screen readers announce "link, pound sign".
  it("names the link with the heading text, not the # glyph", () => {
    render(<AnchoredHeading id="governing-law">14. Governing law and disputes</AnchoredHeading>);
    const link = screen.getByRole("link", { name: "14. Governing law and disputes" });
    expect(link).toHaveAttribute("href", "#governing-law");
  });

  it("hides the # glyph from assistive tech — it is decoration, not content", () => {
    const { container } = render(<AnchoredHeading id="general">16. General</AnchoredHeading>);
    const glyph = container.querySelector('[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveTextContent("#");
    // Exactly one link, named once: no duplicate-link noise in the heading.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  // The hover-reveal trap: a hover-ONLY affordance is unreachable by keyboard. The reveal must fire
  // on :focus-visible too — and it must be driven by OPACITY, never `visibility:hidden`, which would
  // pull the glyph out of the a11y tree and out of the reveal entirely.
  //
  // (`hidden md:inline` is fine and is not that trap: it's a viewport concern, not a state one. The
  // focusable element is the link wrapping the heading TEXT — always visible, always tabbable — so
  // dropping the decorative glyph on touch, where there is no hover and the gutter would clip it,
  // costs a keyboard user nothing. What would be a bug is hiding it in a way that focus can't undo.)
  it("reveals the affordance on keyboard focus, not hover alone", () => {
    const { container } = render(
      <AnchoredHeading id="your-account">3. Your account</AnchoredHeading>,
    );
    const glyph = container.querySelector('[aria-hidden="true"]')!;
    expect(glyph.className).toContain("opacity-0");
    expect(glyph.className).toContain("group-hover/anchor:opacity-100");
    expect(glyph.className).toContain("group-focus-visible/anchor:opacity-100");
    expect(glyph.className).not.toContain("invisible");
  });

  // The group must sit on the element that actually takes focus — the <a>. Putting it on the <h2>
  // leaves every class string correct and the affordance permanently invisible to keyboard users,
  // because `group-focus-visible` keys off the group element's OWN state and an <h2> never focuses.
  // Shipped exactly that bug once; jsdom passed it green, a real browser caught it.
  it("hangs the group off the focusable element, not the heading", () => {
    const { container } = render(<AnchoredHeading id="contact">15. Contact</AnchoredHeading>);
    const heading = screen.getByRole("heading", { level: 2 });
    const link = screen.getByRole("link", { name: "15. Contact" });

    expect(link.className).toContain("group/anchor");
    expect(heading.className).not.toContain("group/anchor");
    // …and the heading still positions the glyph that hangs in its margin.
    expect(heading.className).toContain("relative");
    expect(container.querySelector('[aria-hidden="true"]')!.className).toContain("absolute");
  });

  // The affordance is decoration; the LINK is the function. Whatever we do to the glyph responsively,
  // the whole heading must stay a reachable, named link at every viewport.
  it("keeps the heading itself linkable even where the glyph is not shown", () => {
    render(<AnchoredHeading id="children">11. Children</AnchoredHeading>);
    const link = screen.getByRole("link", { name: "11. Children" });
    expect(link.className).not.toContain("hidden");
    expect(link).toHaveAttribute("href", "#children");
  });

  // Under a 60px sticky nav, a fragment jump lands the heading *behind* the header without this.
  it("offsets the scroll target so it clears the sticky nav", () => {
    render(<AnchoredHeading id="cookies">10. Cookies</AnchoredHeading>);
    expect(screen.getByRole("heading", { level: 2 }).className).toContain("scroll-mt-24");
  });

  // LegalDoc styles every descendant <a> as underlined body-weight link text. Left alone, that turns
  // every section heading into a big underlined link.
  it("does not inherit the prose link treatment", () => {
    render(<AnchoredHeading id="indemnification">10. Indemnification</AnchoredHeading>);
    const link = screen.getByRole("link", { name: "10. Indemnification" });
    expect(link.className).toContain("no-underline");
    expect(link.className).toContain("text-inherit");
  });

  it("composes without axe violations", async () => {
    const { container } = render(
      <AnchoredHeading id="acceptable-use">4. Acceptable use</AnchoredHeading>,
    );
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
