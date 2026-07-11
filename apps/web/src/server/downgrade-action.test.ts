import { beforeEach, describe, expect, it, vi } from "vitest";

// The undo action's only job: turn a CancelDowngradeResult into the `?downgrade=` flag the billing page
// renders as a banner. `ok` and `error` must never be conflated — one means the booked downgrade is off, the
// other means it is still coming.

const nav = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => nav);

const session = vi.hoisted(() => ({ verifySession: vi.fn() }));
vi.mock("./session", () => session);

const planSwitch = vi.hoisted(() => ({ cancelPendingDowngrade: vi.fn(), switchPlan: vi.fn() }));
vi.mock("./plan-switch", () => planSwitch);

vi.mock("./billing", () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));
vi.mock("./overage", () => ({ applyOverageToggle: vi.fn() }));

import { cancelDowngradeAction } from "./plan-actions";

beforeEach(() => {
  vi.clearAllMocks();
  session.verifySession.mockResolvedValue({ orgId: "org-1", userId: "user-1" });
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
