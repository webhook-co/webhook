import { describe, expect, it } from "vitest";

import type { DeliveryStatsDay } from "@webhook-co/db";

import { buildDashboardChart } from "./dashboard-chart";

// NOW = 2026-07-07T12:00Z. The chart is the last N UTC days ending today (inclusive), zero-filling gaps so
// the axis is continuous even though the rollup omits empty days.
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);

function day(daysAgo: number, patch: Partial<DeliveryStatsDay>): DeliveryStatsDay {
  const iso = new Date(Date.UTC(2026, 6, 7) - daysAgo * 86_400_000).toISOString();
  return { windowStart: iso, delivered: 0, dead: 0, blocked: 0, p95DurationMs: null, ...patch };
}

describe("buildDashboardChart", () => {
  it("returns exactly `days` bars, oldest→newest, ending on today (UTC)", () => {
    const m = buildDashboardChart([], 7, NOW);
    expect(m.bars).toHaveLength(7);
    expect(m.bars[0].date).toBe("2026-07-01");
    expect(m.bars[6].date).toBe("2026-07-07");
    expect(m.bars[6].label).toBe("Jul 7");
  });

  it("zero-fills days the rollup omitted, and places rows on their UTC date", () => {
    const series = [
      day(0, { delivered: 5, dead: 1 }),
      day(2, { delivered: 3, blocked: 2 }),
      // day 1 intentionally absent → must appear as a zero bar between them.
    ];
    const m = buildDashboardChart(series, 3, NOW);
    expect(m.bars.map((b) => ({ date: b.date, delivered: b.delivered, failed: b.failed }))).toEqual(
      [
        { date: "2026-07-05", delivered: 3, failed: 2 }, // day 2
        { date: "2026-07-06", delivered: 0, failed: 0 }, // gap
        { date: "2026-07-07", delivered: 5, failed: 1 }, // today
      ],
    );
  });

  it("folds dead + blocked into `failed` and sums window totals", () => {
    const series = [
      day(0, { delivered: 10, dead: 2, blocked: 3 }),
      day(1, { delivered: 4, dead: 1 }),
    ];
    const m = buildDashboardChart(series, 2, NOW);
    expect(m.totalDelivered).toBe(14);
    expect(m.totalDead).toBe(3);
    expect(m.totalBlocked).toBe(3);
    expect(m.totalFailed).toBe(6);
    expect(m.bars[1].failed).toBe(5); // today: 2 dead + 3 blocked
    expect(m.hasAnyDelivery).toBe(true);
  });

  it("maxTotal is the largest single-day total, floored at 1 for an empty window", () => {
    expect(buildDashboardChart([], 5, NOW).maxTotal).toBe(1);
    const m = buildDashboardChart(
      [day(0, { delivered: 7, dead: 1 }), day(1, { delivered: 3 })],
      2,
      NOW,
    );
    expect(m.maxTotal).toBe(8); // today's 7+1 beats yesterday's 3
  });

  it("surfaces the freshest measured p95, skipping days that measured none", () => {
    const series = [
      day(0, { delivered: 1, p95DurationMs: null }), // today: measured none
      day(1, { delivered: 2, p95DurationMs: 240 }), // yesterday: measured
      day(2, { delivered: 2, p95DurationMs: 900 }), // older
    ];
    const m = buildDashboardChart(series, 3, NOW);
    expect(m.latestP95Ms).toBe(240); // freshest non-null, not today's null nor the older 900
  });

  it("reports no p95 and no delivery for a truly empty window", () => {
    const m = buildDashboardChart([], 14, NOW);
    expect(m.latestP95Ms).toBeNull();
    expect(m.hasAnyDelivery).toBe(false);
    expect(m.totalDelivered + m.totalFailed).toBe(0);
  });
});
