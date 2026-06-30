import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

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
      /the same event, wherever you work/i,
      /received once, in order, never silently dropped/i,
      /when a signature fails/i,
      /verification built in for \d+ providers/i,
      /private by default, open at the core/i,
      /point a webhook at it/i,
    ];
    for (const name of titles) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("renders the live inspector inside the hero with its seed counter and accessible summary", () => {
    render(<HomePage />);
    const inspector = screen.getByRole("group", { name: /live webhook inspector/i });
    expect(within(inspector).getByText(/1,284/)).toBeInTheDocument();
    expect(within(inspector).getByText(/an illustrative live feed/i)).toBeInTheDocument();
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

  it("marks the not-yet-GA delivery showcase as 'soon'", () => {
    render(<HomePage />);
    const delivery = screen.getByRole("region", {
      name: /received once, in order, never silently dropped/i,
    });
    expect(within(delivery).getByText("soon")).toBeInTheDocument();
  });

  it("renders the real Standard Webhooks link in the verification showcase", () => {
    render(<HomePage />);
    // Scoped to the verification section — the footer and nav also link "Standard Webhooks".
    const verification = screen.getByRole("region", { name: /when a signature fails/i });
    expect(within(verification).getByRole("link", { name: "Standard Webhooks" })).toHaveAttribute(
      "href",
      "https://www.standardwebhooks.com/",
    );
  });

  it("renders the closing call to action", () => {
    render(<HomePage />);
    // "Start free" / "Read the docs" appear in both the hero and the final CTA — assert presence,
    // not an exact count, so the count rides on the hero regardless of the final CTA's button set.
    expect(screen.getAllByRole("link", { name: /start free/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /read the docs/i }).length).toBeGreaterThan(0);
  });

  it("keeps the resource links discoverable in the footer (the Resources section was removed)", () => {
    render(<HomePage />);
    const developers = screen.getByRole("navigation", { name: /developers/i });
    expect(within(developers).getByRole("link", { name: /quickstart/i })).toBeInTheDocument();
    expect(within(developers).getByRole("link", { name: /api reference/i })).toBeInTheDocument();
  });

  // The providers wall adds ~85 nodes; the full-page axe pass is legitimately slower on CI (no
  // violations — just more DOM to walk), so this single semantics scan gets a generous timeout.
  it("composes without axe violations (semantics — contrast is the real-browser job's)", async () => {
    const { container } = render(<HomePage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
