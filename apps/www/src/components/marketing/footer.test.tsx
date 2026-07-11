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

  // About / Blog / X / LinkedIn / the status indicator have no destination in the product. They are
  // rendered as TEXT, not as links to nowhere. An `href="#"` would be focusable, would announce as a
  // link, and — with smooth scrolling enabled by any earlier click — would glide the reader from the
  // footer back to the hero. Ships zero dead links, and the labels still say the surface is coming.
  it("ships no link that goes nowhere", () => {
    const { container } = render(<Footer />);
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href"), "a footer link with no destination").toBeTruthy();
    }
  });

  it("still shows the surfaces that don't exist yet, just not as links", () => {
    render(<Footer />);
    for (const label of ["About", "Blog"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: label })).toBeNull();
    }
    // The uptime line stays visible, but it is no longer a link to a status page we don't have.
    expect(screen.getByText(/All systems operational/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /All systems operational/i })).toBeNull();
  });

  it("composes without axe violations", async () => {
    const { container } = render(<Footer />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
