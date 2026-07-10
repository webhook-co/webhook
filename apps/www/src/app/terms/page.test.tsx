import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import TermsPage from "./page";

describe("TermsPage", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the document title as the single h1", () => {
    render(<TermsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /^terms of service$/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<TermsPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders the load-bearing sections as h2s", () => {
    render(<TermsPage />);
    const sections = [
      /who we are/i,
      /acceptable use/i,
      /plans, billing, renewals/i,
      /limitation of liability/i,
      /governing law and disputes/i,
    ];
    for (const name of sections) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("links to the privacy policy", () => {
    render(<TermsPage />);
    expect(screen.getAllByRole("link", { name: /privacy policy/i }).length).toBeGreaterThan(0);
  });

  it("composes without axe violations (semantics)", async () => {
    const { container } = render(<TermsPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
