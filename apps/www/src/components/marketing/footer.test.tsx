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
    expect(byLabel["Open source"]).toBe("https://github.com/webhook-co/webhook");
  });

  it("wires the Product column, including Pricing (which pointed at nothing while /pricing was live)", () => {
    render(<Footer />);
    const byLabel = Object.fromEntries(
      columnLinks("Product").map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(byLabel["Pricing"]).toBe("/pricing");
    expect(byLabel["Overview"]).toBe("/");
    expect(byLabel["MCP server"]).toBe("https://docs.webhook.co/mcp/overview");
  });

  // The changelog existed the whole time (a Mintlify tab); it was `#` only because nobody wired it.
  it("wires the Company column to what exists", () => {
    render(<Footer />);
    const byLabel = Object.fromEntries(
      columnLinks("Company").map((a) => [a.textContent, a.getAttribute("href")]),
    );
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

  // About / Blog / X / LinkedIn / the status indicator have no destination in the product yet. They
  // are deliberately inert — this pins that it's a KNOWN gap, so the count can't quietly grow.
  it("leaves exactly the known-missing surfaces inert", () => {
    const { container } = render(<Footer />);
    const inert = [...container.querySelectorAll('a[href="#"]')].map(
      (a) => a.getAttribute("aria-label") ?? a.textContent,
    );
    expect(inert.sort()).toEqual(
      [
        "About",
        "All systems operational",
        "Blog",
        "webhook.co on LinkedIn",
        "webhook.co on X",
      ].sort(),
    );
  });

  it("composes without axe violations", async () => {
    const { container } = render(<Footer />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
