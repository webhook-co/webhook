import { providerDisplayName } from "@webhook-co/ui";
import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { PROVIDER_NAMES } from "./provider-names";
import { ProviderWall } from "./provider-wall";

// The registry, re-derived here exactly as the generator did. This import is TEST-ONLY: pulling
// webhooks-spec into shipped code costs bundle bytes and breaks the TS program (Workers-vs-DOM libs).
const EXPECTED = [...PROVIDERS]
  .map((p) => providerDisplayName(p))
  .sort((a, b) => a.localeCompare(b));

// The wall's whole value is that it is TRUE: it is the inventory of what the code can actually
// verify. So it is derived from the adapter registry rather than typed out, and this test pins that
// derivation — a hand-maintained list of 142 names would start lying the day someone adds the 143rd
// adapter, with nothing to notice.

describe("ProviderWall", () => {
  it("is the registry, not a hand-typed list — regenerate provider-names.ts if this fails", () => {
    // THE PIN. If someone adds an adapter, or renames one, this fails and names the drift.
    expect(PROVIDER_NAMES).toEqual(EXPECTED);
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

  it("does NOT claim all 142 are cryptographically verified — some are token/basic auth", () => {
    const { container } = render(<ProviderWall />);
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(100); // non-vacuous
    expect(text).not.toMatch(/cryptographically/i);
    expect(text).not.toMatch(/HMAC[- ]verified/i);
  });

  it("renders no <img> — the wall is names, not third-party logos", () => {
    const { container } = render(<ProviderWall />);
    // Logos would mean either bundling 142 files (over the byte budget) or hotlinking third-party
    // favicons (breaks `img-src 'self'`), and would imply an endorsement none of them gave us.
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ProviderWall />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
