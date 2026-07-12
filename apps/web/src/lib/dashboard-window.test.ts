import { describe, expect, it } from "vitest";

import {
  DASHBOARD_DEFAULT_DAYS,
  DASHBOARD_MAX_DAYS,
  resolveDashboardWindow,
} from "./dashboard-window";

const NOW = Date.UTC(2026, 6, 12, 15, 0, 0); // 2026-07-12T15:00Z

describe("resolveDashboardWindow", () => {
  it("defaults to the last 14 days ending now when no filter is set", () => {
    const w = resolveDashboardWindow({}, NOW);
    expect(w).toEqual({ days: DASHBOARD_DEFAULT_DAYS, endMs: NOW, label: "Last 14 days" });
  });

  it("maps a relative preset to its day count, ending now", () => {
    expect(resolveDashboardWindow({ range: "7d" }, NOW)).toMatchObject({ days: 7, endMs: NOW });
    expect(resolveDashboardWindow({ range: "30d" }, NOW)).toMatchObject({
      days: 30,
      label: "Last 30 days",
    });
    // Sub-day presets collapse to a single day on a daily rollup (honest day-granular view).
    expect(resolveDashboardWindow({ range: "24h" }, NOW).days).toBe(1);
    expect(resolveDashboardWindow({ range: "1h" }, NOW).days).toBe(1);
  });

  it("a valid preset OWNS the window — stray from/to are ignored", () => {
    const w = resolveDashboardWindow({ range: "7d", from: "2020-01-01", to: "2020-02-01" }, NOW);
    expect(w).toMatchObject({ days: 7, endMs: NOW });
  });

  it("resolves a custom range with an EXCLUSIVE `to`, ending on the last included day", () => {
    // from 2026-07-01 (inclusive) to 2026-07-08 (exclusive) → 7 days, ending 2026-07-07.
    const w = resolveDashboardWindow({ from: "2026-07-01", to: "2026-07-08" }, NOW);
    expect(w.days).toBe(7);
    expect(w.endMs).toBe(Date.UTC(2026, 6, 7));
    expect(w.label).toBe("2026-07-01 – 2026-07-07");
  });

  it("clamps an over-long custom range to the max, and a degenerate one to at least a day", () => {
    const huge = resolveDashboardWindow({ from: "2020-01-01", to: "2026-01-01" }, NOW);
    expect(huge.days).toBe(DASHBOARD_MAX_DAYS);
    // to <= from → not a valid forward range → falls back to default.
    const backwards = resolveDashboardWindow({ from: "2026-07-08", to: "2026-07-01" }, NOW);
    expect(backwards.days).toBe(DASHBOARD_DEFAULT_DAYS);
  });

  it("falls back to the default for malformed input (never throws)", () => {
    expect(resolveDashboardWindow({ range: "nonsense" }, NOW).days).toBe(DASHBOARD_DEFAULT_DAYS);
    expect(resolveDashboardWindow({ from: "not-a-date", to: "2026-07-08" }, NOW).days).toBe(
      DASHBOARD_DEFAULT_DAYS,
    );
    expect(resolveDashboardWindow({ from: "2026-07-01" }, NOW).days).toBe(DASHBOARD_DEFAULT_DAYS); // to missing
  });
});
