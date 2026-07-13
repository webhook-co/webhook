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
  session.requireOrgAccess.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "owner" });
});

describe("cancelDowngradeAction", () => {
  it.each([
    ["ok", "/billing?downgrade=ok"],
    ["nothing_pending", "/billing?downgrade=nothing_pending"],
    ["forbidden", "/billing?downgrade=forbidden"],
    ["no_subscription", "/billing?downgrade=no_subscription"],
    ["disabled", "/billing?downgrade=disabled"],
    ["error", "/billing?downgrade=error"],
  ])("maps %s → %s", async (status, expected) => {
    planSwitch.cancelPendingDowngrade.mockResolvedValue({ status });
    await cancelDowngradeAction();
    expect(nav.redirect).toHaveBeenCalledWith(expected);
  });

  it("passes the acting user, so the undo is gated and audited against a real principal", async () => {
    planSwitch.cancelPendingDowngrade.mockResolvedValue({ status: "ok" });
    await cancelDowngradeAction();
    expect(planSwitch.cancelPendingDowngrade).toHaveBeenCalledWith("org-1", "user-1");
  });
});

describe("switchPlanAction", () => {
  it.each([
    ["ok", "/billing?switch=ok"],
    ["scheduled", "/billing?switch=scheduled"], // a downgrade booked for period end — NOT applied now
    ["same_plan", "/billing?switch=same_plan"],
    ["forbidden", "/billing?switch=forbidden"],
    ["error", "/billing?switch=error"],
  ])("maps %s → %s", async (status, expected) => {
    planSwitch.switchPlan.mockResolvedValue({ status, plan: "pro" });
    const form = new FormData();
    form.set("planId", "pro");
    await switchPlanAction(form);
    expect(nav.redirect).toHaveBeenCalledWith(expected);
  });

  it("NEVER reports a scheduled downgrade as an applied switch (they'd think they lost volume today)", async () => {
    planSwitch.switchPlan.mockResolvedValue({ status: "scheduled", plan: "pro" });
    const form = new FormData();
    form.set("planId", "pro");
    await switchPlanAction(form);
    expect(nav.redirect).not.toHaveBeenCalledWith("/billing?switch=ok");
  });
});
