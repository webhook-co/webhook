import { describe, expect, it } from "vitest";

import { PLAN_RETENTION_DAYS } from "./retention";
import { SELF_SERVE_PLAN_IDS, SELF_SERVE_PLAN_LABELS } from "./billing";
import {
  FREE_EVENT_CAP,
  OVERAGE_PER_MILLION,
  PLAN_IDS,
  PLANS,
  SELF_SERVE_PLANS,
  planById,
} from "./plans";

// The catalog is now the single source of the plan ladder. These tests are the DRIFT GUARD that was missing:
// nothing previously cross-checked the four sources of plan truth against each other, so retention.ts,
// billing.ts and apps/www's pricing copy could silently disagree. They must all agree with PLANS.

describe("plan catalog — shape", () => {
  it("pins the ladder ids and order (upgrade order; used to rank a downgrade)", () => {
    expect(PLAN_IDS).toEqual(["free", "pro", "scale", "enterprise"]);
    expect(PLANS.map((p) => p.id)).toEqual([...PLAN_IDS]);
  });

  it("pins the public prices — this is what Stripe charges", () => {
    expect(planById("free")?.price).toBeNull();
    expect(planById("pro")?.price).toBe("€19");
    expect(planById("scale")?.price).toBe("€99");
    expect(planById("enterprise")?.price).toBe("€499");
    expect(OVERAGE_PER_MILLION).toBe("€25");
  });

  it("pins the numeric event caps (must equal Stripe metadata.event_cap)", () => {
    expect(planById("free")?.eventCap).toBe(FREE_EVENT_CAP);
    expect(FREE_EVENT_CAP).toBe(5_000);
    expect(planById("pro")?.eventCap).toBe(500_000);
    expect(planById("scale")?.eventCap).toBe(3_000_000);
    expect(planById("enterprise")?.eventCap).toBeNull(); // committed/custom, not a self-serve number
  });

  // The whole shape of the ladder: price per event must FALL as you climb (upgrading buys cheaper events).
  it("price per event falls monotonically across the paid self-serve tiers", () => {
    const eur = (p: string) => Number(p.replace("€", ""));
    const perEvent = SELF_SERVE_PLANS.map((p) => eur(p.price!) / (p.eventCap as number));
    for (let i = 1; i < perEvent.length; i++) {
      expect(perEvent[i]).toBeLessThan(perEvent[i - 1]);
    }
  });

  it("the display string agrees with the numeric cap (no copy/number drift within the catalog)", () => {
    // pro/scale spell their cap with thousands separators; the number must be embedded in the copy.
    expect(planById("pro")?.includedEvents).toContain("500,000");
    expect(planById("scale")?.includedEvents).toContain("3,000,000");
    expect(planById("free")?.includedEvents).toContain("5,000");
  });
});

describe("plan catalog — is the single source (retention.ts + billing.ts agree)", () => {
  // retention.ts's PLAN_RETENTION_DAYS is the pricing-copy retention map. Every catalog entry's retentionDays
  // must equal it, and vice versa — one number to change.
  it("every plan's retentionDays equals PLAN_RETENTION_DAYS", () => {
    for (const plan of PLANS) {
      expect(plan.retentionDays, `retention for ${plan.id}`).toBe(PLAN_RETENTION_DAYS[plan.id]);
    }
    // And no tier exists in one map but not the other.
    expect(Object.keys(PLAN_RETENTION_DAYS).sort()).toEqual([...PLAN_IDS].sort());
  });

  it("the retention DISPLAY line agrees with retentionDays", () => {
    expect(planById("pro")?.retention).toBe("30-day retention");
    expect(planById("scale")?.retention).toBe("90-day retention");
    expect(planById("free")?.retention).toBe("7-day retention");
    expect(planById("enterprise")?.retentionDays).toBeNull(); // unlimited; stated publicly as "up to 1 year"
    expect(planById("enterprise")?.retention).toMatch(/1 year/);
  });

  // billing.ts's SELF_SERVE_PLAN_IDS is what Checkout sells; the catalog's selfServe flag must name exactly
  // that set, and the labels must match.
  it("the self-serve set + labels equal billing.ts", () => {
    expect(SELF_SERVE_PLANS.map((p) => p.id)).toEqual([...SELF_SERVE_PLAN_IDS]);
    for (const plan of SELF_SERVE_PLANS) {
      expect(plan.name, `label for ${plan.id}`).toBe(
        SELF_SERVE_PLAN_LABELS[plan.id as keyof typeof SELF_SERVE_PLAN_LABELS],
      );
    }
  });
});
