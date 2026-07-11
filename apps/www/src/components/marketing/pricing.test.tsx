import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { PricingHero, PricingTable } from "./pricing";
import { OVERAGE_PER_MILLION, TIERS } from "./pricing-tiers";

// The figures on this page are what Stripe actually charges.
//
// The MUST-disclose set — "churn lands you paused" (ADR-0004) and "a delivery is a billed event"
// (Definition B) — used to be pinned here against <PricingDisclosures>. That component is gone; the
// disclosures now live in the FAQ, rendered `<details open>` so they stay visible without a click.
// **The tripwire moved with them: see `faq.test.tsx` → "FAQ — the MUST-disclose set".** It was not
// deleted, because deleting the guard is not the same as satisfying it.

describe("pricing ladder (the sanctioned figures)", () => {
  it("is exactly Free / Pro / Scale / Enterprise, in ladder order", () => {
    expect(TIERS.map((t) => t.id)).toEqual(["free", "pro", "scale", "enterprise"]);
  });

  it("carries the real prices and included volumes", () => {
    const byId = Object.fromEntries(TIERS.map((t) => [t.id, t]));
    expect(byId.free.price).toBeNull();
    expect(byId.free.includedEvents).toContain("5,000");
    expect(byId.pro.price).toBe("€19");
    expect(byId.pro.includedEvents).toContain("500,000");
    expect(byId.scale.price).toBe("€99");
    expect(byId.scale.includedEvents).toContain("3,000,000");
    expect(byId.enterprise.pricePrefix).toBe("From");
    expect(byId.enterprise.price).toBe("€499");
    expect(byId.enterprise.includedEvents).toContain("20,000,000");
    expect(OVERAGE_PER_MILLION).toBe("€25");
  });

  it("a long price qualifier is a separate field, so it can't wrap away from the amount", () => {
    // "From €499" as one string wrapped as "From … /month" with "€499" orphaned on the next line.
    expect(TIERS.find((t) => t.id === "enterprise")?.pricePrefix).toBe("From");
    expect(TIERS.filter((t) => t.pricePrefix).map((t) => t.id)).toEqual(["enterprise"]);
  });

  it("price per event FALLS as you climb — upgrading must never cost more per event", () => {
    const perEvent = (price: number, events: number) => price / events;
    const pro = perEvent(19, 500_000);
    const scale = perEvent(99, 3_000_000);
    const ent = perEvent(499, 20_000_000);
    expect(scale).toBeLessThan(pro);
    expect(ent).toBeLessThan(scale);
  });

  it("only Enterprise is contact-sales; the rest link into the app", () => {
    const byId = Object.fromEntries(TIERS.map((t) => [t.id, t]));
    expect(byId.enterprise.cta.href).toMatch(/^mailto:/);
    for (const id of ["free", "pro", "scale"]) {
      expect(byId[id].cta.href).toMatch(/^https:\/\/app\.webhook\.co/);
    }
  });
});

describe("PricingTable", () => {
  it("renders every tier with its price", () => {
    render(<PricingTable />);
    for (const tier of TIERS) {
      expect(screen.getByRole("heading", { name: tier.name })).toBeInTheDocument();
    }
    expect(screen.getByText("€19")).toBeInTheDocument();
    expect(screen.getByText("€99")).toBeInTheDocument();
  });

  it("states that features are not gated by plan", () => {
    render(<PricingTable />);
    expect(screen.getByText(/don't gate features by plan/i)).toBeInTheDocument();
  });
});

describe("public-repo content hygiene", () => {
  it("never names a competitor", () => {
    const { container } = render(
      <>
        <PricingHero />
        <PricingTable />
      </>,
    );
    const text = container.textContent ?? "";
    for (const name of ["Svix", "Hookdeck", "Zapier", "Convoy", "ngrok"]) {
      expect(text).not.toContain(name);
    }
  });

  it('never claims "unlimited"', () => {
    const { container } = render(
      <>
        <PricingHero />
        <PricingTable />
      </>,
    );
    expect(container.textContent ?? "").not.toMatch(/unlimited/i);
  });
});

describe("accessibility", () => {
  it("the pricing table has no axe violations", async () => {
    const { container } = render(<PricingTable />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
