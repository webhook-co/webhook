import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";

import { axeComponent } from "@/test/axe";

import PricingPage from "@/app/pricing/page";

import { PricingDisclosure } from "./pricing-disclosure";

// AGENTS.md is not advisory here: pricing must be "disclosed up front… on the pricing page", the
// billable unit stated, and the soft cap must "pause rather than surprise".
//
// That promise used to be kept by forcing five FAQ entries OPEN. The FAQ now starts fully collapsed
// (it's an accordion; that's what a reader expects), so the disclosure moved into its own block. This
// file is the guard on that move: it fails if the disclosure is missing, is tucked inside a <details>,
// or stops stating any of the three things the constitution names.
//
// If you are here because a test went red after "tidying up" the pricing page: the fix is to restore
// the disclosure, not to relax the test.

describe("the pricing disclosure", () => {
  beforeEach(() => {
    mockMatchMedia(true); // the Nav renders a ThemeToggle, which reads prefers-color-scheme
  });

  it("states the billable unit, the alert, and the pause", () => {
    const { container } = render(<PricingDisclosure />);
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(200); // non-vacuous

    // The billable unit — the single thing AGENTS.md names explicitly.
    expect(text).toMatch(/one event = one captured request/i);
    expect(text).toMatch(/a delivery to a destination is one event/i);
    // Retries don't double-bill, and a refused delivery isn't billed.
    expect(text).toMatch(/retries/i);
    // "disclosure + ALERTS + pause" — the pre-limit email is a load-bearing third of the promise.
    expect(text).toMatch(/email you/i);
    expect(text).toMatch(/pause/i);
    // …and cancelling doesn't destroy data.
    expect(text).toMatch(/cancelling/i);
  });

  it("is NOT collapsible — a disclosure behind a click is not 'up front'", () => {
    const { container } = render(<PricingDisclosure />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("[hidden]")).toBeNull();
  });

  it("appears on the pricing page, outside any accordion", () => {
    const { container } = render(<PricingPage />);
    const heading = screen.getByRole("heading", { name: /what you pay for, before you sign up/i });
    expect(heading).toBeInTheDocument();
    // The load-bearing assertion: it must not have been swallowed by a <details> somewhere up the tree.
    expect(
      heading.closest("details"),
      "the disclosure must not sit inside an accordion",
    ).toBeNull();
    expect(container.textContent).toMatch(/one event = one captured request/i);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<PricingDisclosure />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
