import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import HomePage from "./page";

describe("HomePage", () => {
  // Render deterministically: reduced motion pauses the live stream (no interval) and resolves the
  // scroll reveals immediately, so the static tree is stable to assert against.
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the hero headline as the single h1", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /the webhook platform built for the agent era/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<HomePage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders every content section title as an h2", () => {
    render(<HomePage />);
    const titles = [
      /a webhook is an event/i,
      /every webhook, the moment it lands/i,
      /the same event, wherever you work/i,
      /turn a received webhook into an agent event/i,
      /a permanent url, full inspection/i,
      /received once, in order, never dropped/i,
      /when a signature fails/i,
      /start where it makes sense for you/i,
      /private by default, open at the core/i,
      /point a webhook at it/i,
    ];
    for (const name of titles) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("renders the live-inspector stage with its seed counter and accessible summary", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("region", { name: /every webhook, the moment it lands/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/an illustrative live feed/i)).toBeInTheDocument();
    expect(screen.getByText(/1,284/)).toBeInTheDocument();
  });

  it("renders the surfaces tablist with MCP selected by default", () => {
    render(<HomePage />);
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "CLI" })).toHaveAttribute("aria-selected", "false");
  });

  it("renders the Product and Developers nav dropdowns, collapsed by default", () => {
    render(<HomePage />);
    expect(screen.getByRole("button", { name: /^product$/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /^developers$/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("marks the not-yet-GA showcases as 'soon' and leaves the live wedge unmarked", () => {
    render(<HomePage />);
    const mcp = screen.getByRole("region", {
      name: /turn a received webhook into an agent event/i,
    });
    const delivery = screen.getByRole("region", {
      name: /received once, in order, never dropped/i,
    });
    const capture = screen.getByRole("region", { name: /a permanent url, full inspection/i });
    expect(within(mcp).getByText("soon")).toBeInTheDocument();
    expect(within(delivery).getByText("soon")).toBeInTheDocument();
    expect(within(capture).queryByText("soon")).not.toBeInTheDocument();
  });

  it("renders the replay terminal line and the real Standard Webhooks link", () => {
    render(<HomePage />);
    // Scoped to the capture·replay showcase — "replayed" also appears in the surfaces web panel.
    const capture = screen.getByRole("region", { name: /a permanent url, full inspection/i });
    expect(within(capture).getByText(/replayed/i)).toBeInTheDocument();
    // Scoped to the verification section — the footer and nav also link "Standard Webhooks".
    const verification = screen.getByRole("region", { name: /when a signature fails/i });
    expect(within(verification).getByRole("link", { name: "Standard Webhooks" })).toHaveAttribute(
      "href",
      "https://www.standardwebhooks.com/",
    );
  });

  it("renders the resource cards and the closing call to action", () => {
    render(<HomePage />);
    // Scoped to the resources section — the footer carries the same link labels.
    const resources = screen.getByRole("region", { name: /start where it makes sense for you/i });
    expect(within(resources).getByRole("link", { name: /quickstart/i })).toBeInTheDocument();
    expect(within(resources).getByRole("link", { name: /api reference/i })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /start free/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /read the docs/i }).length).toBeGreaterThan(0);
  });
});
