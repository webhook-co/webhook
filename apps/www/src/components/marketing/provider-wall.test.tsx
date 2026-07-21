import { existsSync } from "node:fs";
import { join } from "node:path";

import { PROVIDER_LOGO_PATHS, providerDisplayName, providerIconDomain } from "@webhook-co/ui";
import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { PROVIDER_ENTRIES } from "./provider-entries";
import { ProviderWall } from "./provider-wall";

// The registry, re-derived here exactly as the generator did. This import is TEST-ONLY: pulling
// webhooks-spec into shipped code costs bundle bytes and breaks the TS program (Workers-vs-DOM libs).
const EXPECTED = [...PROVIDERS]
  .map((slug) => ({
    slug,
    name: providerDisplayName(slug),
    domain: providerIconDomain(slug) ?? "",
    mark: Boolean(PROVIDER_LOGO_PATHS[slug]),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const ICON_DIR = join(__dirname, "../../../public/providers");

// The wall's whole value is that it is TRUE: it is the inventory of what the code can actually
// verify. So it is derived from the adapter registry rather than typed out, and pinned here — a
// hand-maintained list of 141 would start lying the day someone adds the 142nd adapter.

describe("ProviderWall", () => {
  it("is the registry, not a hand-typed list — regenerate provider-entries.ts if this fails", () => {
    // THE PIN. Add or rename an adapter and this fails, naming the drift.
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

  it("has a committed icon for EVERY provider without a vector mark", () => {
    // The guard that makes the two-tier mark scheme safe. A provider with no vector mark renders
    // <img src="/providers/<slug>.webp"> — a file fetched once by scripts/fetch-provider-icons.mjs
    // and committed. Add a provider and forget to run it, and the wall would ship a BROKEN IMAGE.
    // This fails first, and tells you exactly what to run.
    const missing = PROVIDER_ENTRIES.filter(
      (p) => !p.mark && !existsSync(join(ICON_DIR, `${p.slug}.webp`)),
    ).map((p) => p.slug);
    expect(
      missing,
      `missing icons — run: node --experimental-strip-types scripts/fetch-provider-icons.mjs`,
    ).toEqual([]);
    // Anti-vacuity: there really ARE logo-less providers, so the check above isn't passing on an
    // empty set.
    expect(PROVIDER_ENTRIES.filter((p) => !p.mark).length).toBeGreaterThan(10);
  });

  it("renders an inline vector for marked providers and a static icon for the rest", () => {
    const { container } = render(<ProviderWall />);
    const marked = PROVIDER_ENTRIES.filter((p) => p.mark);
    const unmarked = PROVIDER_ENTRIES.filter((p) => !p.mark);
    expect(marked.length).toBeGreaterThan(50); // non-vacuous
    expect(unmarked.length).toBeGreaterThan(10);

    expect(container.querySelectorAll("svg")).toHaveLength(marked.length);
    expect(container.querySelector("svg path")).toHaveAttribute("d"); // inline path data, not a ref
    expect(container.querySelectorAll("img")).toHaveLength(unmarked.length);
  });

  it("requests NOTHING from a third party — every icon is same-origin and static", () => {
    const { container } = render(<ProviderWall />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.length).toBeGreaterThan(0); // non-vacuous
    for (const img of imgs) {
      const src = img.getAttribute("src") ?? "";
      // A hotlink would break the `img-src 'self'` CSP and leak a visitor's request to a third party.
      expect(src).toMatch(/^\/providers\/[a-z0-9_]+\.webp$/);
      // …and NOT the dashboard's favicon-proxy route, which doesn't exist on a static export.
      expect(src).not.toContain("/api/provider-icon");
      // Dimensions are set, or 141 icons landing one by one would shift the page (CLS gate).
      expect(img).toHaveAttribute("width");
      expect(img).toHaveAttribute("height");
    }
    expect(container.innerHTML).not.toMatch(/https?:\/\/(?!docs\.webhook\.co)/);
  });

  it("keeps every brand mark decorative — the name is the accessible text, said once", () => {
    const { container } = render(<ProviderWall />);
    for (const el of [...container.querySelectorAll("svg, img")]) {
      expect(el).toHaveAttribute("aria-hidden", "true");
      expect(el).not.toHaveAttribute("aria-label");
    }
  });

  it("does NOT claim all 141 are cryptographically verified — some are token/basic auth", () => {
    const { container } = render(<ProviderWall />);
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(100); // non-vacuous
    expect(text).not.toMatch(/cryptographically/i);
    expect(text).not.toMatch(/HMAC[- ]verified/i);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ProviderWall />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 30000); // 141 pills is a big DOM for axe; slow on CI. A time limit, not a weaker assertion.
});
