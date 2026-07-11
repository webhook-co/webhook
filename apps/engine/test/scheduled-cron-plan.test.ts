import { describe, expect, it } from "vitest";

import { CAP_PRODUCER_CRON, HOURLY_CRON, scheduledCronPlan } from "../src/index";

// The cron dispatch split (S4): scheduled() runs the soft-cap producer on its OWN frequent trigger so a
// pause lands within minutes, and the heavy hourly jobs (rollup/reconcilers/purges) on the hourly trigger.
// scheduledCronPlan is the pure routing decision. The invariants it must uphold:
//   - the `*/5` cap tick runs the cap producer but NOT the heavy hourly jobs (else 12× load + racing);
//   - EVERY other tick runs the cap producer too, as an idempotent backstop, so a dropped/drifted `*/5`
//     trigger degrades pause latency to ~1h instead of failing OPEN to unbounded over-cap ingest;
//   - the hourly jobs never silently stop on an unrecognised expression.

describe("scheduledCronPlan", () => {
  it("runs ONLY the cap producer on the dedicated */5 cap trigger", () => {
    expect(scheduledCronPlan(CAP_PRODUCER_CRON)).toEqual({ runsCap: true, runsHourly: false });
  });

  it("runs the hourly jobs AND the cap-producer backstop on the hourly trigger", () => {
    // The cap producer runs on the hourly tick too — the fail-safe that keeps the cap enforced if the
    // dedicated */5 trigger is ever dropped or drifts from CAP_PRODUCER_CRON.
    expect(scheduledCronPlan(HOURLY_CRON)).toEqual({ runsCap: true, runsHourly: true });
  });

  it("normalises whitespace so a reformatted cap trigger still routes to cap-only", () => {
    expect(scheduledCronPlan("  */5   *  *  *  * ")).toEqual({ runsCap: true, runsHourly: false });
  });

  it("FAILS SAFE on an unknown/absent expression — runs the hourly jobs AND the cap backstop", () => {
    // An unrecognised trigger must never silently drop the hourly jobs (rollups/reconcilers/purges), and
    // must still enforce the cap. So the fallthrough runs BOTH — only the exact */5 cap trigger is cap-only.
    expect(scheduledCronPlan(undefined)).toEqual({ runsCap: true, runsHourly: true });
    expect(scheduledCronPlan("*/10 * * * *")).toEqual({ runsCap: true, runsHourly: true });
    expect(scheduledCronPlan("")).toEqual({ runsCap: true, runsHourly: true });
  });
});
