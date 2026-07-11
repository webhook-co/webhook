import { beforeEach, describe, expect, it, vi } from "vitest";

// The cancel server action's ONLY job is to turn a CancelRefundResult into the `?cancel=` flag the billing
// page renders as a banner. That mapping is load-bearing and worth its own test: `refund_failed` and
// `refund_unavailable` mean the subscription IS cancelled and we owe money, while `error` means nothing
// happened. Collapsing those into one another either has the user cancel twice (thinking it failed) or
// walk away believing a refund is coming that isn't.

const nav = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => nav);

const session = vi.hoisted(() => ({ verifySession: vi.fn() }));
vi.mock("./session", () => session);

const cancel = vi.hoisted(() => ({ cancelSubscriptionWithRefund: vi.fn() }));
vi.mock("./cancel-refund", () => cancel);

// The action module also pulls these in; stub them so importing it doesn't drag in the world.
vi.mock("./billing", () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));
vi.mock("./overage", () => ({ applyOverageToggle: vi.fn() }));
vi.mock("./plan-switch", () => ({ switchPlan: vi.fn() }));

import { cancelSubscriptionAction } from "./plan-actions";

beforeEach(() => {
  vi.clearAllMocks();
  session.verifySession.mockResolvedValue({ orgId: "org-1", userId: "user-1" });
});

describe("cancelSubscriptionAction", () => {
  it.each([
    ["ok", "/billing?cancel=ok"],
    ["refund_unavailable", "/billing?cancel=refund_unavailable"],
    ["refund_failed", "/billing?cancel=refund_failed"],
    ["forbidden", "/billing?cancel=forbidden"],
    ["no_subscription", "/billing?cancel=no_subscription"],
    ["disabled", "/billing?cancel=disabled"],
    ["error", "/billing?cancel=error"],
  ])("maps %s → %s", async (status, expected) => {
    cancel.cancelSubscriptionWithRefund.mockResolvedValue({ status, refundMinorUnits: 0 });
    await cancelSubscriptionAction();
    expect(nav.redirect).toHaveBeenCalledWith(expected);
  });

  it("passes the acting user through, so the cancel is gated and audited against a real principal", async () => {
    cancel.cancelSubscriptionWithRefund.mockResolvedValue({ status: "ok", refundMinorUnits: 0 });
    await cancelSubscriptionAction();
    expect(cancel.cancelSubscriptionWithRefund).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("NEVER lets a cancelled-but-unrefunded outcome reach the user as a plain failure", async () => {
    // The regression this guards: mapping refund_failed → `?cancel=error` would render "Nothing changed —
    // try again" over a subscription that IS cancelled and money we DO owe.
    for (const status of ["refund_failed", "refund_unavailable"]) {
      vi.clearAllMocks();
      cancel.cancelSubscriptionWithRefund.mockResolvedValue({ status, refundMinorUnits: 950 });
      await cancelSubscriptionAction();
      expect(nav.redirect).not.toHaveBeenCalledWith("/billing?cancel=error");
    }
  });
});
