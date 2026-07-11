import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

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
    expect(byLabel["MCP server"]).toBe("/product/mcp");
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
    expect(byLabel["Security"]).toBe("https://docs.webhook.co/concepts/security");
    expect(byLabel["Contact"]).toBe("mailto:sourabh@webhook.co");
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

  it("links the GitHub social — the only one that exists", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /on GitHub/i })).toHaveAttribute(
      "href",
      "https://github.com/webhook-co/webhook",
    );
  });

  // X / LinkedIn / the status indicator have no destination in the product. They are rendered as
  // TEXT, not as links to nowhere. An `href="#"` would be focusable, would announce as a link, and —
  // with smooth scrolling enabled by any earlier click — would glide the reader from the footer back
  // to the hero. Ships zero dead links. (About and Blog USED to be here; About is now a real page and
  // Blog became Guides — both real links.)
  it("ships no link that goes nowhere", () => {
    const { container } = render(<Footer />);
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href"), "a footer link with no destination").toBeTruthy();
    }
  });

  // "Blog" is gone entirely — renamed to Guides, no separate blog. Its former inert-text sibling
  // "About" is now a real link. The socials that still have no account (X, LinkedIn) remain text.
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
