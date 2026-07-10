import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { PricingDisclosures, PricingHero, PricingTable } from "./pricing";
import { OVERAGE_PER_MILLION, TIERS } from "./pricing-tiers";

// The figures on this page are what Stripe actually charges. The disclosures are not decoration: ADR-0004
// marks "churn lands you paused" as MUST-disclose, and Definition B makes "a delivery is a billed event"
// something a customer must be able to read before they pay. These tests exist so neither can be quietly
// dropped in a redesign.

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

describe("PricingDisclosures — the MUST-disclose set", () => {
  it("says a delivery is a billed event (Definition B)", () => {
    render(<PricingDisclosures />);
    expect(screen.getByText(/A delivery to a destination is one event/i)).toBeInTheDocument();
    expect(screen.getByText(/that's four events/i)).toBeInTheDocument();
  });

  it("says retries are never billed", () => {
    render(<PricingDisclosures />);
    expect(screen.getByRole("heading", { name: /Retries are never billed/i })).toBeInTheDocument();
  });

  it("says capture PAUSES at the limit rather than billing", () => {
    render(<PricingDisclosures />);
    expect(screen.getByRole("heading", { name: /capture pauses/i })).toBeInTheDocument();
  });

  it("discloses that CANCELLING lands you paused — ADR-0004 marks this MUST-disclose", () => {
    render(<PricingDisclosures />);
    expect(screen.getByText(/capture pauses until you resubscribe/i)).toBeInTheDocument();
    expect(screen.getByText(/never reset/i)).toBeInTheDocument();
  });

  it("discloses the dedup=off trade", () => {
    render(<PricingDisclosures />);
    expect(
      screen.getByText(/every retry a provider sends is a distinct captured request/i),
    ).toBeInTheDocument();
  });

  it("does not swallow the space after a bolded lead-in", () => {
    // JSX drops a leading space that sits directly after a closing tag, and prettier normalises `{" "}`
    // back into that same droppable space. It rendered as "default.If you". Pinned here because it is
    // invisible in review and only shows up in the built HTML.
    const { container } = render(<PricingDisclosures />);
    const text = container.textContent ?? "";
    expect(text).toContain("Deduplication is on by default. If you turn it off");
    expect(text).not.toContain("default.If");
  });
});

describe("public-repo content hygiene", () => {
  it("never names a competitor", () => {
    const { container } = render(
      <>
        <PricingHero />
        <PricingTable />
        <PricingDisclosures />
      </>,
    );
    const text = container.textContent ?? "";
    for (const name of ["Svix", "Hookdeck", "Zapier", "Convoy", "ngrok"]) {
      expect(text).not.toContain(name);
    }
  });

  it('never claims "unlimited"', () => {
    const { container } = render(<PricingDisclosures />);
    expect(container.textContent ?? "").not.toMatch(/unlimited/i);
  });
});

describe("accessibility", () => {
  it("the pricing table has no axe violations", async () => {
    const { container } = render(<PricingTable />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });

  it("the disclosures have no axe violations", async () => {
    const { container } = render(<PricingDisclosures />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
