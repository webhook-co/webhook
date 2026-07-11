import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { LegalDoc } from "./legal-doc";

/** The element that carries the prose typography (the sibling of the h1/updated line). */
function proseClasses(container: HTMLElement): string {
  const prose = container.querySelector("article > div");
  expect(prose).not.toBeNull();
  return prose!.className;
}

function renderDoc() {
  return render(
    <LegalDoc title="Terms of Service" updated="11 July 2026">
      <blockquote>
        <strong>In short:</strong> the plain-language summary.
      </blockquote>
      <h2>A section</h2>
      <p>Some body prose.</p>
      <table>
        <tbody>
          <tr>
            <td>A cell</td>
          </tr>
        </tbody>
      </table>
    </LegalDoc>,
  );
}

describe("LegalDoc", () => {
  // Long-form legal text is READ, not scanned. The design system already carries a reading size
  // (`md`) and its own token file names it "marketing/docs body" — but the prose column never opted
  // in, so it silently inherited the dense product-UI default. This asserts it opts in.
  it("sets prose at the reading size, not the product-UI body default", () => {
    const { container } = renderDoc();
    expect(proseClasses(container)).toContain("text-md");
  });

  // A `ch` is the width of the "0" glyph, which is wider than the average character — so 72ch is
  // really ~90 characters per line, past WCAG 1.4.8's 80 and well past the 45–75 that reads well.
  // And because `ch` scales with the font, raising the size does not fix it.
  it("holds the measure to a readable line length", () => {
    const { container } = renderDoc();
    const article = container.querySelector("article");
    expect(article?.className).toContain("max-w-[58ch]");
    expect(article?.className).not.toContain("72ch");
  });

  // The "In short" box is the most-read prose on the page — it was also the smallest (13px).
  // It must never again be set smaller than the prose it summarises.
  it("does not shrink the plain-language summary below the prose size", () => {
    const { container } = renderDoc();
    expect(proseClasses(container)).not.toContain("[&_blockquote]:text-sm");
  });

  // An h3 set BELOW the body size is upside-down: a subheading that whispers.
  it("never sets a subheading smaller than the prose it introduces", () => {
    const { container } = renderDoc();
    expect(proseClasses(container)).not.toContain("[&_h3]:text-base");
  });

  // Dead until a heading carried an id; this is what makes a deep link land below the sticky nav.
  it("keeps scroll-margin on the headings a deep link can target", () => {
    const { container } = renderDoc();
    const prose = proseClasses(container);
    expect(prose).toContain("[&_h2]:scroll-mt-24");
    expect(prose).toContain("[&_h3]:scroll-mt-24");
  });

  // A heading's permalink is still a heading. The prose-link rule ([&_a]:underline, font-medium) is a
  // DESCENDANT selector, so it outranks the classes on the link itself — it underlined every section
  // title and dropped it from semibold to medium. Scoping it to prose containers is what stops that.
  // Playwright asserts the computed result; this asserts the rule can't creep back.
  it("does not apply the prose-link treatment to heading permalinks", () => {
    const { container } = renderDoc();
    const prose = proseClasses(container);
    expect(prose).not.toContain("[&_a]:underline");
    expect(prose).not.toContain("[&_a]:font-medium");
    // …but prose links themselves are still styled.
    expect(prose).toContain("[&_:where(p,li,td,th,blockquote)_a]:underline");
  });

  it("renders the title as the h1 and the updated date", () => {
    renderDoc();
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByText(/11 July 2026/)).toBeInTheDocument();
  });

  it("composes without axe violations (semantics)", async () => {
    const { container } = renderDoc();
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
