import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlanCard } from "./plan-card";

// One shared card for BOTH the marketing pricing grid (CTA = <a>) and the dashboard billing cards
// (CTA = a Checkout/Switch <form>, current plan renders a badge). Its contract is the plan facts it lays out
// + the slots (badge, cta) each surface fills.

const PRO = {
  id: "pro" as const,
  name: "Pro",
  price: "€19",
  cadence: "/month",
  includedEvents: "500,000 events / month",
  eventCap: 500_000,
  summary: "For a service in production with real traffic.",
  retention: "30-day retention",
  retentionDays: 30,
  overage: "€25 per extra million events",
  featured: true,
  selfServe: true,
};
const FREE = {
  ...PRO,
  id: "free" as const,
  name: "Free",
  price: null,
  cadence: null,
  featured: false,
};

describe("PlanCard", () => {
  it("lays out the plan facts: name, summary, price, cadence, included events, overage, retention", () => {
    render(<PlanCard plan={PRO} />);
    expect(screen.getByRole("heading", { level: 2, name: "Pro" })).toBeInTheDocument();
    expect(screen.getByText(PRO.summary)).toBeInTheDocument();
    expect(screen.getByText("€19")).toBeInTheDocument();
    expect(screen.getByText("/month")).toBeInTheDocument();
    expect(screen.getByText("500,000 events / month")).toBeInTheDocument();
    expect(screen.getByText("€25 per extra million events")).toBeInTheDocument();
    expect(screen.getByText("30-day retention")).toBeInTheDocument();
  });

  it("renders 'Free' when price is null (no cadence)", () => {
    render(<PlanCard plan={FREE} />);
    expect(screen.getByText("Free", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("/month")).not.toBeInTheDocument();
  });

  it("shows the featured 'Most teams' badge by default for a featured plan", () => {
    render(<PlanCard plan={PRO} />);
    expect(screen.getByText("Most teams")).toBeInTheDocument();
  });

  it("does NOT show the featured badge for a non-featured plan", () => {
    render(<PlanCard plan={FREE} />);
    expect(screen.queryByText("Most teams")).not.toBeInTheDocument();
  });

  it("lets the dashboard OVERRIDE the badge (e.g. 'Current plan')", () => {
    render(<PlanCard plan={PRO} badge={<span>Current plan</span>} />);
    expect(screen.getByText("Current plan")).toBeInTheDocument();
    // The override replaces the default featured badge, not stacks with it.
    expect(screen.queryByText("Most teams")).not.toBeInTheDocument();
  });

  it("renders the CTA slot — an <a> for marketing", () => {
    render(<PlanCard plan={PRO} cta={<a href="/signup">Start on Pro</a>} />);
    expect(screen.getByRole("link", { name: "Start on Pro" })).toHaveAttribute("href", "/signup");
  });

  it("renders the CTA slot — a <form> button for the dashboard", () => {
    render(
      <PlanCard
        plan={PRO}
        cta={
          <form>
            <button type="submit">Switch to Pro</button>
          </form>
        }
      />,
    );
    expect(screen.getByRole("button", { name: "Switch to Pro" })).toBeInTheDocument();
  });

  it("highlights a featured plan's border, and lets a caller highlight explicitly (current plan)", () => {
    const { container: a } = render(<PlanCard plan={PRO} />);
    expect(a.firstElementChild).toHaveClass("border-fg"); // featured → highlighted
    const { container: b } = render(<PlanCard plan={FREE} highlighted />);
    expect(b.firstElementChild).toHaveClass("border-fg"); // explicit highlight on a non-featured plan
    const { container: c } = render(<PlanCard plan={FREE} />);
    expect(c.firstElementChild).toHaveClass("border-hairline"); // not featured, not highlighted
  });
});
