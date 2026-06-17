import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import NotFound from "./not-found";

describe("NotFound (404)", () => {
  // Match the homepage tests: reduced motion makes the nav/footer islands render deterministically.
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a single h1 and a working link back home", () => {
    render(<NotFound />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // Every link on a 404 must resolve — the primary action returns to the real homepage.
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute("href", "/");
  });

  it("keeps the site chrome (skip link + nav + footer) for orientation", () => {
    render(<NotFound />);
    // The skip link must match its `<main id="main">` target, same as every other page.
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("navigation", { name: /main/i })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("composes without axe violations (semantics — contrast is the real-browser job's)", async () => {
    const { container } = render(<NotFound />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
