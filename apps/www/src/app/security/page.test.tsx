import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import SecurityPage, { metadata } from "./page";

// /security is a TRUST page, not a product page — security isn't a capability we sell, it's the
// question a buyer asks before they'll use any of them. It moved out of /product/* for that reason,
// which also moved it out of the product suite's honesty guard. It needs that guard MORE than the
// product pages do: it is the single likeliest page on the site to sprout a compliance claim we
// cannot back. Everything here is verified against shipped code (RLS, KMS-for-secrets, hash-chained
// audit, Apache-2.0) — and the FORBIDDEN list below is what we do NOT have.

const FORBIDDEN: RegExp[] = [
  /SOC 2/i, // no audit, no report
  /HIPAA/i, // no BAA
  /\bPCI\b/i,
  /SAML/i, // the button is disabled in the app
  /ISO 27001/i,
  /penetration test(ed)?/i,
  /zero[- ]knowledge/i, // we hold the keys; saying otherwise is a lie
  /end[- ]to[- ]end encrypted/i,
  /\bcompliant\b/i, // compliance-BY-DESIGN is the claim; "compliant" is a certification claim
  /EU (data )?residency/i, // region pinning is designed for, not shipped
];

describe("/security", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders exactly one h1", () => {
    render(<SecurityPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /private by default, open at the core/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("lives at /security — not under /product/, because security is not a product", () => {
    expect(metadata.alternates?.canonical).toBe("/security");
    expect(String(metadata.alternates?.canonical)).not.toContain("/product/");
  });

  it("makes NO compliance claim we cannot back", () => {
    const { container } = render(<SecurityPage />);
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(200); // non-vacuous: there IS copy to scan
    for (const claim of FORBIDDEN) {
      expect(text, `must not claim ${claim}`).not.toMatch(claim);
    }
  });

  it("has a main landmark wired to the skip link", () => {
    render(<SecurityPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<SecurityPage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
