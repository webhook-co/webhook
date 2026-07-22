import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { COMPARISONS } from "@/lib/comparisons";

import { Footer } from "./footer";

const columnLinks = (name: string) =>
  within(screen.getByRole("navigation", { name })).getAllByRole("link");

describe("Footer", () => {
  it("wires every Developers link to a real destination", () => {
    render(<Footer />);
    const byLabel = Object.fromEntries(
      columnLinks("Developers").map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(byLabel["Docs"]).toBe("https://docs.webhook.co");
    expect(byLabel["Quickstart"]).toBe("https://docs.webhook.co/quickstart");
    expect(byLabel["API reference"]).toBe("https://docs.webhook.co/api-reference/introduction");
    expect(byLabel["CLI"]).toBe("https://docs.webhook.co/cli/overview");
    expect(byLabel["MCP"]).toBe("https://docs.webhook.co/mcp/overview");
  });

  // Row 2 is COLUMNS now, not a band. See the note in footer.tsx for why the band's original
  // "a column caps out, a band wraps" reasoning stopped applying: growth moved sideways into a new
  // column instead of downwards inside one, so the cap it worried about is no longer the binding
  // constraint. Row 2 still sits AFTER row 1, so the socials-<ul>-is-first assumption below holds.
  it("carries a Resources column with the three usable tools, in order", () => {
    render(<Footer />);
    const links = columnLinks("Resources");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Signature verifier", "/verify"],
      ["Webhook tutorials", "/test"],
      ["Sandbox", "/play"],
    ]);
  });

  // The comparison estate gets its OWN column beside Resources — the founder's ask, and the reason
  // row 2 became a grid. It links the hub plus a small, capped number of named comparisons: a hub
  // alone gives the estate one inbound link and no signal about what is in it, while a link per
  // competitor is link-stuffing that orphans the next one. Three named + the hub is the compromise.
  it("carries a Compare column that leads with the hub", () => {
    render(<Footer />);
    const links = columnLinks("Compare");
    expect(links[0].textContent).toBe("All comparisons");
    expect(links[0]).toHaveAttribute("href", "/vs");
  });

  // While the estate is small the column names every comparison — four competitor links is a useful
  // index, not link-stuffing (founder call, 2026-07-22). The cap is what stops that staying true by
  // default: at the FIFTH comparison `1 + COMPARISONS.length` exceeds it and this test goes red,
  // which forces a deliberate decision about what the footer shows instead of letting the column grow
  // until the grid unbalances. That is the failure the old band comment predicted, now prevented by a
  // test rather than by a comment nobody re-reads.
  it("names every comparison while the set is small, and forces a decision when it grows", () => {
    render(<Footer />);
    const links = columnLinks("Compare");
    expect(
      links.length,
      "the Compare column has outgrown the footer — link a subset and let the hub carry the rest",
    ).toBeLessThanOrEqual(5);
    expect(links.length, "every comparison should be named while there are four or fewer").toBe(
      1 + COMPARISONS.length,
    );
  });

  // The estate must be reachable from every page, or check-orphan-pages.mjs reds the build. This is
  // that guarantee expressed as a unit test, so it fails in milliseconds rather than after a build.
  it("links the comparison hub from the site chrome", () => {
    const { container } = render(<Footer />);
    const hrefs = within(container)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/vs");
  });

  // Moved OUT of Developers, deliberately. Developers is docs deep-links; the verifier is a tool you
  // use. Pinned in both directions so a merge that restores the old row shows up as a failure.
  it("no longer lists the signature verifier under Developers", () => {
    render(<Footer />);
    expect(columnLinks("Developers").map((a) => a.textContent)).not.toContain("Signature verifier");
  });

  // The tutorial hub is the ONLY /test link the chrome carries — never individual provider slugs.
  // Sixteen footer links would be link-stuffing, and the seventeenth tutorial would be orphaned again.
  it("links the tutorial hub and never an individual tutorial slug", () => {
    const { container } = render(<Footer />);
    const hrefs = within(container)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/test");
    expect(hrefs.filter((h) => h.startsWith("/test/"))).toEqual([]);
  });

  // Developers is where a developer looks for OUR docs. "Standard Webhooks" (a third-party spec) and
  // "Open source" (the repo) both sent them off-site from the column meant to keep them here, and the
  // repo already has a home in the socials row below. Removed on purpose — pinned so a future tidy-up
  // doesn't quietly re-add them.
  it("sends nobody off-site from the Developers column", () => {
    render(<Footer />);
    const labels = columnLinks("Developers").map((a) => a.textContent);
    expect(labels).not.toContain("Standard Webhooks");
    expect(labels).not.toContain("Open source");
  });

  // The Product column points at the real www /product/* pages now (the IA lane), plus Pricing.
  it("wires the Product column to the www product pages, not docs", () => {
    render(<Footer />);
    const byLabel = Object.fromEntries(
      columnLinks("Product").map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(byLabel["Pricing"]).toBe("/pricing");
    expect(byLabel["Capture & replay"]).toBe("/product/capture-replay");
    expect(byLabel["Verification"]).toBe("/product/verification");
    expect(byLabel["Agent triggers"]).toBe("/product/agent-triggers");
    // No Product-column link leaves for the docs subdomain.
    expect(Object.values(byLabel).some((h) => h?.includes("docs.webhook.co"))).toBe(false);
  });

  // The changelog existed the whole time (a Mintlify tab); it was `#` only because nobody wired it.
  // About is now a real /about page (the entity lane), and "Blog" is renamed to "Guides" pointing at
  // the existing docs guides estate — we don't run a separate blog (founder decision).
  it("wires the Company column to what exists", () => {
    render(<Footer />);
    const byLabel = Object.fromEntries(
      columnLinks("Company").map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(byLabel["About"]).toBe("/about");
    expect(byLabel["Guides"]).toBe("https://docs.webhook.co/guides");
    expect(byLabel["Changelog"]).toBe("https://docs.webhook.co/changelog");
    // Security is a www trust page now, not a docs deep-link: the buyer question is answered on
    // our own domain (docs.webhook.co is a different subdomain — its authority does not accrue here).
    expect(byLabel["Security"]).toBe("/security");
    expect(byLabel["Contact"]).toBe("mailto:hello@webhook.co");
  });

  it("keeps the legal column pointing at the legal routes", () => {
    render(<Footer />);
    const byLabel = Object.fromEntries(
      columnLinks("Legal").map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(byLabel["Terms"]).toBe("/terms");
    expect(byLabel["DPA"]).toBe("/dpa");
    expect(byLabel["Sub-processors"]).toBe("/sub-processors");
  });

  it("links the GitHub and LinkedIn socials to their real profiles", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /on GitHub/i })).toHaveAttribute(
      "href",
      "https://github.com/webhook-co/webhook",
    );
    expect(screen.getByRole("link", { name: /on LinkedIn/i })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/company/webhook-co",
    );
  });

  // X/Twitter was a brand mark with no account behind it, rendered as inert decoration. The founder
  // chose not to create the account (2026-07-20), so the mark is removed ENTIRELY rather than sitting
  // there implying a presence that doesn't exist. The inert X had no accessible name (aria-hidden), so
  // an a11y query can't see it either way — this counts the marks structurally: the socials row is now
  // exactly GitHub + LinkedIn, both real links, no inert third mark.
  it("shows exactly the two real socials (GitHub + LinkedIn), no inert X mark", () => {
    const { container } = render(<Footer />);
    // The socials <ul> is the first list in the footer — it precedes the column navs in the DOM.
    const socials = container.querySelector("ul");
    expect(socials).not.toBeNull();
    const items = within(socials as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Both are links now (X's removal + LinkedIn's wiring leave zero inert marks).
    const links = within(socials as HTMLElement).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("aria-label")).sort()).toEqual([
      "webhook.co on GitHub",
      "webhook.co on LinkedIn",
    ]);
  });

  // Every social now has a real destination. The site still ships zero dead links: an `href="#"`
  // would be focusable, would announce as a link, and — with smooth scrolling enabled by any earlier
  // click — would glide the reader from the footer back to the hero. (About and Blog USED to be inert
  // here; About is now a real page and Blog became Guides — both real links.)
  it("ships no link that goes nowhere", () => {
    const { container } = render(<Footer />);
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href"), "a footer link with no destination").toBeTruthy();
    }
  });

  // "Blog" is gone entirely — renamed to Guides, no separate blog. Its former inert-text sibling
  // "About" is now a real link.
  it("no longer advertises a Blog, and never as inert text", () => {
    render(<Footer />);
    expect(screen.queryByText("Blog")).toBeNull();
    expect(screen.queryByRole("link", { name: "Blog" })).toBeNull();
  });

  // "All systems operational", with a green dot, on every page of the site — wired to nothing. There
  // is no status page and nothing monitoring anything, so it was an uptime claim we could not have
  // known to be true, sitting a few centimetres from a Terms link that disclaims any uptime
  // commitment at all. Un-linking it wasn't enough: the LIE was the sentence, not the href.
  it("publishes no uptime claim it cannot back", () => {
    const { container } = render(<Footer />);
    expect(container.textContent).not.toMatch(/all systems (operational|go|nominal)/i);
  });

  it("composes without axe violations", async () => {
    const { container } = render(<Footer />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
