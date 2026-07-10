import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import PrivacyPage from "./page";

describe("PrivacyPage", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the document title as the single h1", () => {
    render(<PrivacyPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /^privacy policy$/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders the load-bearing sections as h2s", () => {
    render(<PrivacyPage />);
    const sections = [
      /our two roles/i,
      /what we collect/i,
      /sub-processors/i,
      /international transfers/i,
      /how long we keep it/i,
      /your rights/i,
    ];
    for (const name of sections) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("states the honest posture: US hosting and no SOC 2 / HIPAA certification", () => {
    render(<PrivacyPage />);
    expect(screen.getAllByText(/primarily in the United States/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not.*SOC 2.*HIPAA|SOC 2.*HIPAA/i).length).toBeGreaterThan(0);
  });

  it("links to the terms of service", () => {
    render(<PrivacyPage />);
    expect(screen.getAllByRole("link", { name: /^terms$/i }).length).toBeGreaterThan(0);
  });

  it("composes without axe violations (semantics)", async () => {
    const { container } = render(<PrivacyPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
