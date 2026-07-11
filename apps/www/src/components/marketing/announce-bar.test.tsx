import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { AnnounceBar } from "./announce-bar";

describe("AnnounceBar", () => {
  // The bar said "soon" and linked to a roadmap that did not exist — while the MCP server was
  // shipped, prod-verified, and fully documented, and the hero pill two inches below it said "new".
  // The site was underselling its own named differentiator and contradicting itself doing it.
  it("announces the MCP server as shipped, not as roadmap", () => {
    render(<AnnounceBar />);
    expect(screen.getByText(/^new$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^soon$/i)).toBeNull();
    expect(screen.queryByText(/roadmap/i)).toBeNull();
  });

  it("sends the reader to the MCP docs — the destination that actually exists", () => {
    render(<AnnounceBar />);
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://docs.webhook.co/mcp/overview",
    );
  });

  it("ships no link to nowhere", () => {
    const { container } = render(<AnnounceBar />);
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
  });

  it("composes without axe violations", async () => {
    const { container } = render(<AnnounceBar />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
