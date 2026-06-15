import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
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
    expect(screen.getByText(/replayed/i)).toBeInTheDocument();
    // Scoped to the verification section — the footer also links "Standard Webhooks".
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
