import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import AboutPage from "./page";

describe("AboutPage", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a single h1 that frames the solo-builder story", () => {
    render(<AboutPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /one person, on purpose/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("names the real founder (already public on the legal pages) as the entity anchor", () => {
    render(<AboutPage />);
    expect(screen.getByText(/Sourabh Choraria/)).toBeInTheDocument();
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<AboutPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders the load-bearing sections as h2s", () => {
    render(<AboutPage />);
    for (const name of [/why it exists/i, /why one person/i, /what it.s built around/i]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("stays honest: it says pre-launch, never claims a compliance cert or a permanent free URL", () => {
    render(<AboutPage />);
    expect(screen.getByText(/pre-launch/i)).toBeInTheDocument();
    // Guard against the exact overclaims this whole lane exists to remove creeping onto /about.
    expect(screen.queryByText(/SOC 2|HIPAA|free, permanent/i)).not.toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<AboutPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
