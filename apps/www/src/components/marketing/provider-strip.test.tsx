import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { PROVIDER_ENTRIES } from "./provider-entries";
import { ProviderStrip } from "./provider-strip";

// The homepage shows a curated handful of providers rather than all 142. A curated list is exactly
// where a marketing site starts lying — showing a recognisable brand it cannot actually verify. So
// every featured slug is checked against the real registry, and the "142" is derived, never typed.

const REGISTRY = new Set<string>(PROVIDERS);

describe("ProviderStrip", () => {
  it("features ONLY providers the registry can actually verify", () => {
    const { container } = render(<ProviderStrip />);
    const featured = [...container.querySelectorAll("li")];
    expect(featured.length).toBeGreaterThan(8); // non-vacuous: there is a strip to check
    expect(featured.length).toBeLessThan(PROVIDER_ENTRIES.length); // …and it IS a subset

    // Every name rendered must belong to a provider in the registry.
    const names = new Set(PROVIDER_ENTRIES.filter((p) => REGISTRY.has(p.slug)).map((p) => p.name));
    for (const li of featured) {
      const label = li.textContent?.trim() ?? "";
      expect(names, `"${label}" is featured but is not in the adapter registry`).toContain(label);
    }
  });

  it("states the real total, derived from the registry — not a stale literal", () => {
    render(<ProviderStrip />);
    expect(
      screen.getByRole("heading", { level: 2, name: new RegExp(`${PROVIDERS.length} providers`) }),
    ).toBeInTheDocument();
  });

  it("routes to the full registry on /product/verification, and to the docs directory", () => {
    render(<ProviderStrip />);
    const all = screen.getByRole("link", { name: new RegExp(`see all ${PROVIDERS.length}`, "i") });
    expect(all).toHaveAttribute("href", "/product/verification");

    const docs = screen.getByRole("link", { name: /schemes and signature headers/i });
    expect(docs).toHaveAttribute("href", "https://docs.webhook.co/providers/directory");
  });

  it("requests nothing from a third party — icons are same-origin static files", () => {
    const { container } = render(<ProviderStrip />);
    for (const img of [...container.querySelectorAll("img")]) {
      expect(img.getAttribute("src") ?? "").toMatch(/^\/providers\/[a-z0-9_]+\.webp$/);
    }
  });

  it("keeps the marks decorative — the provider name is the accessible text", () => {
    const { container } = render(<ProviderStrip />);
    const list = within(container).getAllByRole("listitem");
    expect(list.length).toBeGreaterThan(0);
    for (const el of [...container.querySelectorAll("svg, img")]) {
      expect(el).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ProviderStrip />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
