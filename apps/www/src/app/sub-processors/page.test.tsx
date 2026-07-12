import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import SubProcessorsPage from "./page";

describe("SubProcessorsPage", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the document title as the single h1", () => {
    render(<SubProcessorsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /^sub-processors$/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<SubProcessorsPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders the sub-processors as a table with the expected columns and rows", () => {
    render(<SubProcessorsPage />);
    const table = screen.getByRole("table");
    for (const header of [/sub-processor/i, /what it does/i, /data it may process/i, /location/i]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    for (const provider of [
      /Cloudflare/i,
      /Neon/i,
      /Amazon Web Services/i,
      /Stripe/i,
      /Resend/i,
      /Google/i,
      /GitHub/i,
      /Mintlify/i,
    ]) {
      expect(within(table).getByRole("rowheader", { name: provider })).toBeInTheDocument();
    }
  });

  it("links to the privacy policy", () => {
    render(<SubProcessorsPage />);
    expect(screen.getAllByRole("link", { name: /privacy policy/i }).length).toBeGreaterThan(0);
  });

  it("composes without axe violations (semantics)", async () => {
    const { container } = render(<SubProcessorsPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
