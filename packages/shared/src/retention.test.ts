import { describe, expect, it } from "vitest";

import {
  FREE_RETENTION_DAYS,
  PLAN_RETENTION_DAYS,
  RETENTION_ACTIVE_RECONCILE_LOOKBACK_DAYS,
  reconcileLookbackDays,
  retentionDaysForPlan,
} from "./retention";

// The per-plan retention policy is the single source of truth for three surfaces: the engine prune cron
// (what it deletes), the meter-reconcile lookback (how far back the money-guard recounts), and the public
// pricing page / docs (what we PROMISE). These tests pin the numbers and the load-bearing safety coupling.

describe("retention policy windows", () => {
  it("Free is a 7-day window (the only tier enforced while billing is dark)", () => {
    expect(FREE_RETENTION_DAYS).toBe(7);
    expect(PLAN_RETENTION_DAYS.free).toBe(7);
  });

  it("paid tiers keep more; enterprise is unlimited (null)", () => {
    expect(PLAN_RETENTION_DAYS.pro).toBe(30);
    expect(PLAN_RETENTION_DAYS.scale).toBe(90);
    expect(PLAN_RETENTION_DAYS.enterprise).toBeNull();
  });

  it("windows are ordered Free < Pro < Scale (a higher tier never retains less)", () => {
    expect(FREE_RETENTION_DAYS).toBeLessThan(PLAN_RETENTION_DAYS.pro as number);
    expect(PLAN_RETENTION_DAYS.pro as number).toBeLessThan(PLAN_RETENTION_DAYS.scale as number);
  });
});

describe("retentionDaysForPlan", () => {
  it("maps each known tier to its window", () => {
    expect(retentionDaysForPlan("free")).toBe(7);
    expect(retentionDaysForPlan("pro")).toBe(30);
    expect(retentionDaysForPlan("scale")).toBe(90);
    expect(retentionDaysForPlan("enterprise")).toBeNull();
  });

  it("fails SAFE for an unknown plan: unlimited (null), never a too-short window", () => {
    // A plan id we don't recognise must NEVER be pruned at the aggressive Free window — that would
    // delete a paying customer's data. Unknown → unlimited (keep everything) is the safe default.
    expect(retentionDaysForPlan("some-future-tier")).toBeNull();
    expect(retentionDaysForPlan("")).toBeNull();
  });
});

describe("reconcileLookbackDays (metering money-guard coupling)", () => {
  it("uses the wide 35-day window while retention pruning is INACTIVE", () => {
    expect(reconcileLookbackDays(false)).toBe(35);
  });

  it("clamps STRICTLY INSIDE the Free window once pruning is active (never reconciles a prunable day)", () => {
    // The prune deletes events with received_at < now() - 7d (a rolling cutoff); the reconciler recounts
    // whole UTC days. A reconciled UTC day whose start is >= now()-lookback can still contain events older
    // than the rolling 7-day cutoff unless lookback <= 6 (the intra-day `now` offset costs one day). So the
    // active lookback is Free-1 = 6: no reconciled day can overlap a pruned event → no false drift alarm.
    expect(RETENTION_ACTIVE_RECONCILE_LOOKBACK_DAYS).toBe(6);
    expect(reconcileLookbackDays(true)).toBe(6);
    expect(reconcileLookbackDays(true)).toBeLessThan(FREE_RETENTION_DAYS);
  });
});
