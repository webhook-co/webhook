import { afterEach, describe, expect, it, vi } from "vitest";

// switchPlan orchestration: gate owner/admin (BEFORE resolving the Stripe secret), then derive the CURRENT
// plan from LIVE Stripe state (retrieveSubscription) and remap the sub's items with immediate proration.
// Uses the REAL shared pure helpers (isSelfServePlan/planIdForBasePrice/planSwitchItems/isBillingActive/
// isBillingManagerRole) — only the env/db/Stripe seams are faked.

const env = vi.hoisted(() => ({
  getBillingMode: vi.fn().mockReturnValue("test"),
  getStripePlans: vi.fn(),
  getAuditChainKey: vi.fn().mockResolvedValue("YWJj"),
}));
vi.mock("./env", () => env);

const billing = vi.hoisted(() => ({ stripeClientFromEnv: vi.fn() }));
vi.mock("./billing", () => billing);

const db = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("./db", () => db);

const log = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => log);

vi.mock("@webhook-co/db/client", () => ({ withTenant: vi.fn() }));
vi.mock("@webhook-co/db/reads", () => ({ readActiveSubscription: vi.fn() }));
vi.mock("@webhook-co/db/audit-append", () => ({ appendAuditEntry: vi.fn() }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: vi.fn().mockResolvedValue({}) }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: vi.fn(() => new Uint8Array()) }));

import { withTenant } from "@webhook-co/db/client";
import { readActiveSubscription } from "@webhook-co/db/reads";

import { cancelPendingDowngrade, switchPlan } from "./plan-switch";

const PLANS = {
  pro: { base: "price_base", overage: "price_overage" },
  scale: { base: "price_scale_base", overage: "price_scale_overage" },
};
const PRO_ITEMS = [
  { id: "si_base", price: "price_base" },
  { id: "si_over", price: "price_overage" },
];

/** Configure the role/sub the tenant read returns + the LIVE Stripe sub retrieveSubscription returns. */
function enable(opts: {
  role?: string | null;
  hasSub?: boolean; // the mirror row exists (controls the pre-retrieve no_subscription check)
  liveStatus?: string;
  liveItems?: Array<{ id: string; price: string }>;
  scheduleId?: string | null;
  cancelAtPeriodEnd?: boolean; // the LIVE sub is set to cancel at period end
}) {
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue(PLANS);

  // Run the tenant callbacks for REAL (against faked reads) instead of stubbing their return value.
  // switchPlan opens a tenant tx twice — once for the role/sub gate, once to append the audit entry — and
  // stubbing the RESULT short-circuits the second one, which would make every "did / didn't audit" assertion
  // below pass vacuously. The seams (the tx, the reads, appendAuditEntry) stay faked; the wiring is real.
  const role = opts.role === undefined ? "owner" : opts.role;
  db.withTenantDb.mockImplementation((cb: (app: unknown) => unknown) => cb({}));
  vi.mocked(withTenant).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_app: unknown, _org: string, cb: (tx: any) => unknown) =>
      cb(async () => [{ role }])) as never,
  );
  vi.mocked(readActiveSubscription).mockResolvedValue(
    opts.hasSub === false
      ? null
      : { subscriptionId: "sub_1", plan: "price_base", status: "active" },
  );

  const client = {
    retrieveSubscription: vi.fn().mockResolvedValue({
      id: "sub_1",
      status: opts.liveStatus ?? "active",
      items: opts.liveItems ?? PRO_ITEMS,
      // A schedule already attached = a downgrade already booked for the end of the period.
      scheduleId: opts.scheduleId ?? null,
      cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
    }),
    retrieveSubscriptionSchedule: vi.fn().mockResolvedValue({
      id: "sub_sched_1",
      currentPhase: {
        startDate: 1_750_000_000,
        endDate: 1_752_000_000,
        items: [{ price: "price_scale_base", quantity: 1 }],
      },
      phases: [
        {
          startDate: 1_750_000_000,
          endDate: 1_752_000_000,
          items: [{ price: "price_scale_base", quantity: 1 }],
        },
        { startDate: 1_752_000_000, items: [{ price: "price_base", quantity: 1 }] },
      ],
    }),
    releaseSubscriptionSchedule: vi.fn().mockResolvedValue({ id: "sub_sched_1" }),
    updateSubscription: vi.fn().mockResolvedValue({ id: "sub_1", status: "active", items: [] }),
    // A DOWNGRADE goes through a subscription schedule instead (see below).
    createSubscriptionSchedule: vi.fn().mockResolvedValue({
      id: "sub_sched_1",
      currentPhase: {
        startDate: 1_750_000_000,
        endDate: 1_752_000_000,
        items: [
          { price: "price_scale_base", quantity: 1 },
          { price: "price_scale_overage", quantity: undefined },
        ],
      },
    }),
    updateSubscriptionSchedule: vi.fn().mockResolvedValue({ id: "sub_sched_1" }),
  };
  billing.stripeClientFromEnv.mockResolvedValue(client);
  return client;
}

const SCALE_ITEMS = [
  { id: "si_base", price: "price_scale_base" },
  { id: "si_over", price: "price_scale_overage" },
];

afterEach(() => vi.clearAllMocks());

describe("switchPlan", () => {
  it("switches an active Pro sub to Scale with immediate proration (current plan from LIVE items)", async () => {
    const client = enable({});
    const res = await switchPlan("org-1", "user-1", "scale");
    expect(res).toEqual({ status: "ok", plan: "scale" });
    const args = client.updateSubscription.mock.calls[0][0];
    expect(args.subscriptionId).toBe("sub_1");
    expect(args.prorationBehavior).toBe("create_prorations");
    expect(args.items).toEqual([
      { id: "si_base", price: "price_scale_base" },
      { id: "si_over", price: "price_scale_overage" },
    ]);
  });

  it("forwards the idempotency nonce to the Stripe write (collapses a double-submit)", async () => {
    const client = enable({});
    await switchPlan("org-1", "user-1", "scale", "nonce-1");
    expect(client.updateSubscription.mock.calls[0][0].idempotencyKey).toBe("nonce-1");
  });

  it("CLEARS cancel_at_period_end when upgrading a subscription that was set to cancel (S6c)", async () => {
    // The money bug: upgrading a CANCELING sub used to charge proration now AND still cancel at period end —
    // the customer pays for headroom they lose at renewal. An upgrade is an affirmative "I'm staying", so we
    // un-cancel it as part of the same Stripe write (founder decision: clear it on upgrade).
    const client = enable({ cancelAtPeriodEnd: true });
    const res = await switchPlan("org-1", "user-1", "scale");
    expect(res).toEqual({ status: "ok", plan: "scale" });
    expect(client.updateSubscription.mock.calls[0][0].cancelAtPeriodEnd).toBe(false);
  });

  it("does NOT touch cancel_at_period_end when upgrading a normal (non-canceling) sub", async () => {
    // Don't send the field unnecessarily — a non-canceling sub's upgrade leaves the flag untouched.
    const client = enable({ cancelAtPeriodEnd: false });
    await switchPlan("org-1", "user-1", "scale");
    expect(client.updateSubscription.mock.calls[0][0].cancelAtPeriodEnd).toBeUndefined();
  });

  it("is disabled when BILLING_MODE is off (no read, no Stripe)", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "disabled" });
  });

  it("rejects a non-self-serve / unknown target BEFORE any read or Stripe call", async () => {
    enable({});
    expect(await switchPlan("org-1", "user-1", "enterprise")).toEqual({ status: "unknown_plan" });
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("rejects a target THIS deploy has no prices for (partial config) — before any read", async () => {
    enable({});
    env.getStripePlans.mockReturnValue({ pro: PLANS.pro }); // no scale
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "unknown_plan" });
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("forbids a plain member — the gate runs BEFORE the Stripe secret is resolved", async () => {
    enable({ role: "member" });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "forbidden" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("forbids a user with NO membership row (role null) — before the secret", async () => {
    enable({ role: null });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "forbidden" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("no_subscription when the org has no mirror sub row", async () => {
    enable({ hasSub: false });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "no_subscription" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("no_subscription when the LIVE sub isn't entitled (canceled/unpaid/paused)", async () => {
    for (const status of ["canceled", "unpaid", "paused"]) {
      const client = enable({ liveStatus: status });
      expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "no_subscription" });
      expect(client.updateSubscription).not.toHaveBeenCalled();
    }
  });

  it("same_plan when the LIVE sub is ALREADY on the target — incl. a lagged retry post-switch", async () => {
    const client = enable({
      liveItems: [
        { id: "si_base", price: "price_scale_base" },
        { id: "si_over", price: "price_scale_overage" },
      ],
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "same_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("unknown_plan when the LIVE sub is on a legacy/unmapped price", async () => {
    const client = enable({
      liveItems: [
        { id: "si_x", price: "price_legacy_base" },
        { id: "si_y", price: "price_legacy_over" },
      ],
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "unknown_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("unknown_plan (refuses) when the LIVE sub carries an EXTRA item — would leave a stray meter", async () => {
    const client = enable({
      liveItems: [...PRO_ITEMS, { id: "si_stray", price: "price_legacy_extra" }],
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "unknown_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("maps a Stripe failure to 'error' (never throws)", async () => {
    const client = enable({});
    client.updateSubscription.mockRejectedValue(new Error("stripe down"));
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "error" });
  });
});

// ── A DOWNGRADE is scheduled, never applied now, and never credits money back ───────────────────────────────
// Founder policy: cancellations and downgrades take effect at the END of the billing period, and we NEVER
// refund automatically. An immediate downgrade would both take away volume the customer already paid for and
// hand them a proration credit — money flowing backward by another name.

describe("switchPlan — downgrade", () => {
  it("SCHEDULES a downgrade for the end of the period instead of applying it now", async () => {
    const client = enable({ liveItems: SCALE_ITEMS }); // currently on Scale

    const res = await switchPlan("org-1", "user-1", "pro"); // → downgrade

    expect(res).toEqual({ status: "scheduled", plan: "pro" });
    // The live subscription is NOT touched — they keep Scale for the rest of the period they paid for.
    expect(client.updateSubscription).not.toHaveBeenCalled();
    expect(client.createSubscriptionSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ fromSubscription: "sub_1" }),
    );
  });

  it("keeps the CURRENT plan as phase 0 (to period end) and starts the target as phase 1", async () => {
    const client = enable({ liveItems: SCALE_ITEMS });

    await switchPlan("org-1", "user-1", "pro");

    const args = client.updateSubscriptionSchedule.mock.calls[0][0];
    expect(args.scheduleId).toBe("sub_sched_1");
    // Phase 0 = what they paid for, ending exactly when the period does.
    expect(args.phases[0]).toEqual({
      startDate: 1_750_000_000,
      endDate: 1_752_000_000,
      items: [
        { price: "price_scale_base", quantity: 1 },
        { price: "price_scale_overage", quantity: undefined },
      ],
    });
    // Phase 1 = the smaller plan, with no dates: it simply begins when phase 0 runs out.
    expect(args.phases[1]).toEqual({
      items: [{ price: "price_base", quantity: 1 }, { price: "price_overage" }],
    });
    expect(args.phases[1].startDate).toBeUndefined();
  });

  it("uses a DETERMINISTIC idempotency key, so a double-click can't create two schedules", async () => {
    const client = enable({ liveItems: SCALE_ITEMS });
    await switchPlan("org-1", "user-1", "pro", "nonce-1");
    // Keyed on the subscription + target, NOT the per-render nonce: two independent downgrade attempts to the
    // same plan must collapse to one schedule at Stripe, not stack up.
    const key = client.createSubscriptionSchedule.mock.calls[0][0].idempotencyKey as string;
    expect(key).toContain("sub_1");
    expect(key).toContain("pro");
    expect(key).not.toContain("nonce-1");
  });

  it("an UPGRADE still applies immediately with a prorated CHARGE (never scheduled)", async () => {
    const client = enable({}); // currently on Pro
    const res = await switchPlan("org-1", "user-1", "scale");
    expect(res).toEqual({ status: "ok", plan: "scale" });
    expect(client.updateSubscription).toHaveBeenCalledOnce();
    expect(client.createSubscriptionSchedule).not.toHaveBeenCalled();
  });

  it("NEVER lets a downgrade reach updateSubscription with create_prorations (that would credit them)", async () => {
    const client = enable({ liveItems: SCALE_ITEMS });
    await switchPlan("org-1", "user-1", "pro");
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("downgrading a CANCELING sub goes through the schedule (its end_behavior:release clears the cancel), not updateSubscription", async () => {
    // A canceling sub that is DOWNgraded doesn't use updateSubscription's cancelAtPeriodEnd param — the
    // schedule is the mechanism. updateSubscriptionSchedule sends `end_behavior: "release"` (verified in the
    // stripe-client), which hands the sub back to normal renewal and clears the pending cancel when phase 1
    // lands. So the cancel is neutralised by the schedule path, not left dangling — the downgrade counterpart
    // of the upgrade's explicit un-cancel.
    const client = enable({ liveItems: SCALE_ITEMS, cancelAtPeriodEnd: true });
    const res = await switchPlan("org-1", "user-1", "pro"); // Scale → Pro downgrade
    expect(res).toEqual({ status: "scheduled", plan: "pro" });
    expect(client.updateSubscription).not.toHaveBeenCalled(); // not the update-in-place path
    expect(client.updateSubscriptionSchedule).toHaveBeenCalled(); // the schedule (end_behavior:release) owns it
  });
});

describe("switchPlan — downgrade failure paths", () => {
  /** The audit entries actually written (the mocked appendAuditEntry's payloads). */
  async function auditActions() {
    const { appendAuditEntry } = await import("@webhook-co/db/audit-append");
    return vi.mocked(appendAuditEntry).mock.calls.map((c) => (c[2] as { action: string }).action);
  }

  it("maps a createSubscriptionSchedule failure to `error` — and never touches the live subscription", async () => {
    const client = enable({ liveItems: SCALE_ITEMS });
    client.createSubscriptionSchedule.mockRejectedValue(new Error("stripe down"));

    expect(await switchPlan("org-1", "user-1", "pro")).toEqual({ status: "error" });
    expect(client.updateSubscriptionSchedule).not.toHaveBeenCalled();
    // The customer keeps Scale. Nothing was charged, credited, or changed.
    expect(client.updateSubscription).not.toHaveBeenCalled();
    expect(await auditActions()).toEqual([]);
  });

  it("maps an updateSubscriptionSchedule failure to `error` and does NOT audit a downgrade that didn't land", async () => {
    // The schedule object exists but carries no target phase, so nothing will actually happen at renewal.
    // Reporting `scheduled` (or auditing one) would tell the user their downgrade is booked when it isn't.
    const client = enable({ liveItems: SCALE_ITEMS });
    client.updateSubscriptionSchedule.mockRejectedValue(new Error("stripe down"));

    expect(await switchPlan("org-1", "user-1", "pro")).toEqual({ status: "error" });
    // ZERO audit entries, not merely "no plan_downgrade_scheduled": a regression that wrote some OTHER
    // action (say `plan_switched`) on a failed downgrade would slip past a not.toContain assertion.
    expect(await auditActions()).toEqual([]);
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("audits a scheduled downgrade distinctly from an applied switch", async () => {
    enable({ liveItems: SCALE_ITEMS });
    await switchPlan("org-1", "user-1", "pro");
    expect(await auditActions()).toEqual(["plan_downgrade_scheduled"]);

    vi.clearAllMocks();
    enable({}); // on Pro → upgrade to Scale
    await switchPlan("org-1", "user-1", "scale");
    expect(await auditActions()).toEqual(["plan_switched"]);
  });

  it("uses the SAME exact idempotency key on both Stripe calls of the downgrade", async () => {
    const client = enable({ liveItems: SCALE_ITEMS });
    await switchPlan("org-1", "user-1", "pro");
    expect(client.createSubscriptionSchedule.mock.calls[0][0].idempotencyKey).toBe(
      "downgrade:sub_1:pro",
    );
    expect(client.updateSubscriptionSchedule.mock.calls[0][0].idempotencyKey).toBe(
      "downgrade:sub_1:pro",
    );
  });
});

// ── The two seams a reviewer found: a booked downgrade must be undoable, and must never outlive an upgrade ──

describe("switchPlan — when a downgrade is ALREADY booked", () => {
  it("an UPGRADE releases the pending schedule first — or the customer would be demoted at renewal anyway", async () => {
    // The dangerous one. Customer books Scale→Pro, changes their mind, upgrades back to Scale. If the schedule
    // is left attached, its "Pro at renewal" phase still fires: they pay MORE now and get DEMOTED later.
    const client = enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });
    // They're on Scale with a Pro downgrade booked; "upgrading" back to Scale is a same_plan no-op, so model
    // the real case: currently on PRO (schedule attached), upgrading to Scale.
    client.retrieveSubscription.mockResolvedValue({
      id: "sub_1",
      status: "active",
      items: PRO_ITEMS,
      scheduleId: "sub_sched_1",
      cancelAtPeriodEnd: false,
    });

    const res = await switchPlan("org-1", "user-1", "scale");

    expect(res).toEqual({ status: "ok", plan: "scale" });
    expect(client.releaseSubscriptionSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sub_sched_1" }),
    );
    // Released BEFORE the upgrade is applied, so no window where both are live.
    const releaseOrder = client.releaseSubscriptionSchedule.mock.invocationCallOrder[0];
    const updateOrder = client.updateSubscription.mock.invocationCallOrder[0];
    expect(releaseOrder).toBeLessThan(updateOrder);
  });

  it("an upgrade of a sub that is BOTH canceling AND has a booked downgrade releases the schedule AND clears the cancel", async () => {
    // The worst-case combined path: a canceling sub with a pending downgrade, upgraded. Both hazards must be
    // neutralised in one switch — release the schedule (no renewal demotion) AND un-cancel (no lost headroom).
    const client = enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });
    client.retrieveSubscription.mockResolvedValue({
      id: "sub_1",
      status: "active",
      items: PRO_ITEMS,
      scheduleId: "sub_sched_1",
      cancelAtPeriodEnd: true,
    });
    const res = await switchPlan("org-1", "user-1", "scale");
    expect(res).toEqual({ status: "ok", plan: "scale" });
    expect(client.releaseSubscriptionSchedule).toHaveBeenCalled();
    expect(client.updateSubscription.mock.calls[0][0].cancelAtPeriodEnd).toBe(false);
  });

  it("a repeat DOWNGRADE updates the EXISTING schedule instead of creating a second one (Stripe would reject)", async () => {
    // Past Stripe's ~24h idempotency window, a second createSubscriptionSchedule on a sub that already has one
    // errors out and the user just sees "something went wrong". Reuse the schedule instead.
    const client = enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });

    const res = await switchPlan("org-1", "user-1", "pro");

    expect(res).toEqual({ status: "scheduled", plan: "pro" });
    expect(client.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(client.updateSubscriptionSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sub_sched_1" }),
    );
  });

  it("an upgrade with NO schedule attached does not call release at all", async () => {
    const client = enable({});
    await switchPlan("org-1", "user-1", "scale");
    expect(client.releaseSubscriptionSchedule).not.toHaveBeenCalled();
  });
});

describe("cancelPendingDowngrade", () => {
  it("releases the schedule, so the booked downgrade never fires", async () => {
    const client = enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });

    const res = await cancelPendingDowngrade("org-1", "user-1");

    expect(res).toEqual({ status: "ok" });
    expect(client.releaseSubscriptionSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sub_sched_1" }),
    );
    // Releasing leaves the subscription exactly as it is — it must NOT change the plan.
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("audits the undo", async () => {
    enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });
    await cancelPendingDowngrade("org-1", "user-1");
    const { appendAuditEntry } = await import("@webhook-co/db/audit-append");
    expect(
      vi.mocked(appendAuditEntry).mock.calls.map((c) => (c[2] as { action: string }).action),
    ).toEqual(["plan_downgrade_cancelled"]);
  });

  it("is a no-op `nothing_pending` when there's no schedule attached", async () => {
    const client = enable({});
    expect(await cancelPendingDowngrade("org-1", "user-1")).toEqual({ status: "nothing_pending" });
    expect(client.releaseSubscriptionSchedule).not.toHaveBeenCalled();
  });

  it("FORBIDS a non-owner/admin, before any Stripe call", async () => {
    enable({ role: "member", scheduleId: "sub_sched_1" });
    expect(await cancelPendingDowngrade("org-1", "user-1")).toEqual({ status: "forbidden" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("never throws — a Stripe fault becomes a clean error", async () => {
    const client = enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });
    client.releaseSubscriptionSchedule.mockRejectedValue(new Error("stripe down"));
    expect(await cancelPendingDowngrade("org-1", "user-1")).toEqual({ status: "error" });
  });
});

describe("switchPlan — upgrade/release partial failures", () => {
  async function auditActions() {
    const { appendAuditEntry } = await import("@webhook-co/db/audit-append");
    return vi.mocked(appendAuditEntry).mock.calls.map((c) => (c[2] as { action: string }).action);
  }

  it("a failed RELEASE must not go on to charge them — the upgrade is never attempted", async () => {
    // If we charged after failing to release, the customer would pay the upgrade AND still be demoted at
    // renewal by the schedule we couldn't clear. Worst of both worlds.
    const client = enable({ scheduleId: "sub_sched_1" }); // on Pro, downgrade booked
    client.releaseSubscriptionSchedule.mockRejectedValue(new Error("stripe down"));

    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "error" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
    expect(await auditActions()).toEqual([]);
  });

  it("release succeeds but the upgrade fails → error, no success audit (they stay put, nothing booked)", async () => {
    const client = enable({ scheduleId: "sub_sched_1" });
    client.updateSubscription.mockRejectedValue(new Error("stripe down"));

    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "error" });
    expect(client.releaseSubscriptionSchedule).toHaveBeenCalledOnce();
    expect(client.updateSubscription).toHaveBeenCalledOnce();
    expect(await auditActions()).toEqual([]);
    // The residual state is SAFE: the booked downgrade is gone and the plan is unchanged, so they simply
    // stay on what they have. Nothing was charged and nothing fires at renewal.
  });

  it("a failed schedule READ on a repeat downgrade maps to error, and never touches the live sub", async () => {
    const client = enable({ liveItems: SCALE_ITEMS, scheduleId: "sub_sched_1" });
    client.retrieveSubscriptionSchedule.mockRejectedValue(new Error("stripe down"));

    expect(await switchPlan("org-1", "user-1", "pro")).toEqual({ status: "error" });
    expect(client.updateSubscriptionSchedule).not.toHaveBeenCalled();
    expect(client.updateSubscription).not.toHaveBeenCalled();
    expect(await auditActions()).toEqual([]);
  });
});
