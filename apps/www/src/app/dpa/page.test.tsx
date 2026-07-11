import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import DpaPage from "./page";

describe("DpaPage", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the document title as the single h1", () => {
    render(<DpaPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /^data processing agreement$/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<DpaPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("carries the Article 28 clauses an enterprise buyer will look for", () => {
    render(<DpaPage />);
    const body = screen.getByRole("main").textContent ?? "";
    for (const clause of [
      "documented instructions",
      "Standard Contractual Clauses",
      "Module Two",
      "Module Three",
      "72 hours", // breach notice
      "30 days", // sub-processor change notice + deletion on close
      "sub-processor",
    ]) {
      expect(body.toLowerCase()).toContain(clause.toLowerCase());
    }
  });

  it("NEVER claims a certification or residency we don't have — a false promise here is worse than none", () => {
    // The load-bearing honesty test. Every one of these has been asserted somewhere in a competitor's DPA and
    // would be read as a commitment; we hold none of them, and the code doesn't back any of them.
    render(<DpaPage />);
    const body = (screen.getByRole("main").textContent ?? "").toLowerCase();
    // It must SAY it lacks them (the negations are present)...
    expect(body).toContain("no soc 2");
    expect(body).toContain("we do not offer");
    // ...and must never assert them affirmatively.
    expect(body).not.toContain("soc 2 certified");
    expect(body).not.toContain("iso 27001 certified");
    expect(body).not.toContain("hipaa compliant");
    expect(body).not.toContain("end-to-end encrypted service");
    expect(body).not.toContain("data stays in the eu");
  });

  it("composes without axe violations (semantics)", async () => {
    const { container } = render(<DpaPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
