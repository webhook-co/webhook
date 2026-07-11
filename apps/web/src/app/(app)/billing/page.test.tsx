import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ verifySession: vi.fn() }));
vi.mock("@/server/session", () => session);

const billing = vi.hoisted(() => ({ loadBillingSummary: vi.fn() }));
vi.mock("@/server/billing", () => billing);

// The server actions are `"use server"` modules; the page only needs them as opaque form actions.
vi.mock("@/server/plan-actions", () => ({
  startCheckoutAction: vi.fn(),
  openBillingPortalAction: vi.fn(),
  setOverageAction: vi.fn(),
  switchPlanAction: vi.fn(),
  cancelDowngradeAction: vi.fn(),
}));

import BillingPage from "./page";

afterEach(() => vi.clearAllMocks());

/** A live Pro subscription with a Stripe customer — every billing control is applicable. */
function view(over: Record<string, unknown> = {}) {
  return {
    hidden: false,
    display: {
      tier: "pro",
      state: "active",
      periodEnd: "2026-08-01T00:00:00.000Z",
    },
    upgradePlanIds: ["pro", "scale"],
    hasCustomer: true,
    overageEnabled: false,
    canManageBilling: true,
    switchTargets: ["scale"],
    pendingDowngrade: null,
    ...over,
  };
}

async function renderPage(v: Record<string, unknown>) {
  session.verifySession.mockResolvedValue({ orgId: "org-1", userId: "u-1", user: {} });
  billing.loadBillingSummary.mockResolvedValue(v);
  render(await BillingPage({ searchParams: Promise.resolve({}) }));
}

// Billing is owner/admin only, and the SERVER now enforces that on Checkout and the Customer Portal too —
// not just on the plan switcher and the overage toggle. So the page must not offer a plain member controls
// whose only possible outcome is `forbidden`. Permission-denied is a designed state: show what's true, and
// say who can act.
describe("BillingPage — the billing-manager gate is reflected in the UI", () => {
  it("offers an owner/admin the Portal and the plan picker", async () => {
    await renderPage(view({ canManageBilling: true }));
    expect(screen.getByRole("button", { name: /manage payment/i })).toBeInTheDocument();
    // One button per offered plan.
    expect(screen.getAllByRole("button", { name: /start on|resubscribe to/i })).toHaveLength(2);
  });

  it("offers a plain member NEITHER — and explains who can", async () => {
    await renderPage(view({ canManageBilling: false }));

    expect(screen.queryByRole("button", { name: /manage payment/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /start on|resubscribe to/i })).toHaveLength(0);

    expect(
      screen.getByText(/only an owner or admin can manage payment and invoices/i),
    ).toBeVisible();
    expect(screen.getByText(/only an owner or admin can start or change a plan/i)).toBeVisible();
  });

  it("still shows a member the plan state — they lose the controls, not the information", async () => {
    await renderPage(view({ canManageBilling: false }));
    expect(screen.getByText(/payment & invoices/i)).toBeInTheDocument();
    expect(screen.getByText(/current plan/i)).toBeInTheDocument();
  });

  it("renders the forbidden banner when the server rejected a billing action", async () => {
    session.verifySession.mockResolvedValue({ orgId: "org-1", userId: "u-1", user: {} });
    billing.loadBillingSummary.mockResolvedValue(view({ canManageBilling: false }));
    render(await BillingPage({ searchParams: Promise.resolve({ billing: "forbidden" }) }));
    expect(screen.getByText(/only an owner or admin can manage billing/i)).toBeVisible();
  });
});
