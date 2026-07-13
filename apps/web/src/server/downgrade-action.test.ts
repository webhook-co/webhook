import { beforeEach, describe, expect, it, vi } from "vitest";

// The undo action's only job: turn a CancelDowngradeResult into the `?downgrade=` flag the billing page
// renders as a banner. `ok` and `error` must never be conflated — one means the booked downgrade is off, the
// other means it is still coming.

const nav = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => nav);

const session = vi.hoisted(() => ({ requireOrgAccess: vi.fn() }));
vi.mock("./org-access", () => session);

const planSwitch = vi.hoisted(() => ({ cancelPendingDowngrade: vi.fn(), switchPlan: vi.fn() }));
vi.mock("./plan-switch", () => planSwitch);

vi.mock("./billing", () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));
vi.mock("./overage", () => ({ applyOverageToggle: vi.fn() }));

import { cancelDowngradeAction, switchPlanAction } from "./plan-actions";

beforeEach(() => {
  vi.clearAllMocks();
  session.requireOrgAccess.mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    // The CANONICAL slug — every post-action redirect below is built from it, not from the raw argument.
    slug: "acme",
    role: "owner",
  });
});

describe("cancelDowngradeAction", () => {
  it.each([
    ["ok", "/org/acme/billing?downgrade=ok"],
    ["nothing_pending", "/org/acme/billing?downgrade=nothing_pending"],
    ["forbidden", "/org/acme/billing?downgrade=forbidden"],
    ["no_subscription", "/org/acme/billing?downgrade=no_subscription"],
    ["disabled", "/org/acme/billing?downgrade=disabled"],
    ["error", "/org/acme/billing?downgrade=error"],
  ])("maps %s → %s", async (status, expected) => {
    planSwitch.cancelPendingDowngrade.mockResolvedValue({ status });
    await cancelDowngradeAction("acme");
    expect(nav.redirect).toHaveBeenCalledWith(expected);
  });

  it("passes the acting user, so the undo is gated and audited against a real principal", async () => {
    planSwitch.cancelPendingDowngrade.mockResolvedValue({ status: "ok" });
    await cancelDowngradeAction("acme");
    expect(planSwitch.cancelPendingDowngrade).toHaveBeenCalledWith("org-1", "user-1");
  });
});

describe("switchPlanAction", () => {
  it.each([
    ["ok", "/org/acme/billing?switch=ok"],
    ["scheduled", "/org/acme/billing?switch=scheduled"], // a downgrade booked for period end — NOT applied now
    ["same_plan", "/org/acme/billing?switch=same_plan"],
    ["forbidden", "/org/acme/billing?switch=forbidden"],
    ["error", "/org/acme/billing?switch=error"],
  ])("maps %s → %s", async (status, expected) => {
    planSwitch.switchPlan.mockResolvedValue({ status, plan: "pro" });
    const form = new FormData();
    form.set("planId", "pro");
    await switchPlanAction("acme", form);
    expect(nav.redirect).toHaveBeenCalledWith(expected);
  });

  it("NEVER reports a scheduled downgrade as an applied switch (they'd think they lost volume today)", async () => {
    planSwitch.switchPlan.mockResolvedValue({ status: "scheduled", plan: "pro" });
    const form = new FormData();
    form.set("planId", "pro");
    await switchPlanAction("acme", form);
    expect(nav.redirect).not.toHaveBeenCalledWith("/org/acme/billing?switch=ok");
  });
});
