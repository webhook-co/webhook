import { providerDisplayName, PROVIDER_LOGO_PATHS } from "@webhook-co/ui";
import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { PROVIDER_ENTRIES } from "./provider-entries";
import { ProviderWall } from "./provider-wall";

// The registry, re-derived here exactly as the generator did. This import is TEST-ONLY: pulling
// webhooks-spec into shipped code costs bundle bytes and breaks the TS program (Workers-vs-DOM libs).
const EXPECTED = [...PROVIDERS]
  .map((slug) => ({ slug, name: providerDisplayName(slug) }))
  .sort((a, b) => a.name.localeCompare(b.name));

// The wall's whole value is that it is TRUE: it is the inventory of what the code can actually
// verify. So it is derived from the adapter registry rather than typed out, and this test pins that
// derivation — a hand-maintained list of 142 names would start lying the day someone adds the 143rd
// adapter, with nothing to notice.

describe("ProviderWall", () => {
  it("is the registry, not a hand-typed list — regenerate provider-entries.ts if this fails", () => {
    // THE PIN. If someone adds an adapter, or renames one, this fails and names the drift.
    expect(PROVIDER_ENTRIES).toEqual(EXPECTED);
  });

  it("lists exactly as many providers as the registry has adapters", () => {
    render(<ProviderWall />);
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(PROVIDERS.length);
  });

  it("states the count in the heading, matching the registry (no stale literal)", () => {
    render(<ProviderWall />);
    expect(
      screen.getByRole("heading", { level: 2, name: new RegExp(`${PROVIDERS.length} providers`) }),
    ).toBeInTheDocument();
  });

  it("renders the real brand mark for every provider that has one", () => {
    const { container } = render(<ProviderWall />);
    const withMark = PROVIDER_ENTRIES.filter((p) => PROVIDER_LOGO_PATHS[p.slug]);
    // Anti-vacuity: there really are marks to render (if the data module went empty, the <svg> count
    // below would be 0 and would still "match" a 0 expectation).
    expect(withMark.length).toBeGreaterThan(50);
    expect(container.querySelectorAll("svg")).toHaveLength(withMark.length);
    // …and the marks are inline path data, not an image reference.
    expect(container.querySelector("svg path")).toHaveAttribute("d");
  });

  it("makes NO third-party or proxied image request — the marks are inline SVG", () => {
    const { container } = render(<ProviderWall />);
    // An <img> would mean either a bundled file (over the byte budget) or a hotlink (breaks the
    // `img-src 'self'` CSP).
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // And crucially: NOT the dashboard's favicon-proxy route. That endpoint doesn't exist on a static
    // export, so every logo-less provider would fire a request that 404s. Hence faviconFallback={false}.
    expect(container.innerHTML).not.toContain("/api/provider-icon");
  });

  it("keeps the brand mark decorative — the name is the accessible text, said once", () => {
    const { container } = render(<ProviderWall />);
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs.length).toBeGreaterThan(0); // non-vacuous
    for (const svg of svgs) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).not.toHaveAttribute("aria-label");
    }
  });

  it("does NOT claim all 142 are cryptographically verified — some are token/basic auth", () => {
    const { container } = render(<ProviderWall />);
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(100); // non-vacuous
    expect(text).not.toMatch(/cryptographically/i);
    expect(text).not.toMatch(/HMAC[- ]verified/i);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ProviderWall />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
