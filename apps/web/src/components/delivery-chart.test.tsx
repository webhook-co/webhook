import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildDashboardChart } from "@/lib/dashboard-chart";

import { DeliveryChart } from "./delivery-chart";

const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);

function day(daysAgo: number, patch: { delivered?: number; dead?: number; blocked?: number }) {
  return {
    windowStart: new Date(Date.UTC(2026, 6, 7) - daysAgo * 86_400_000).toISOString(),
    delivered: 0,
    dead: 0,
    blocked: 0,
    p95DurationMs: null,
    ...patch,
  };
}

describe("DeliveryChart hover tooltip", () => {
  it("shows the hovered day's delivered + failed numbers", () => {
    const model = buildDashboardChart([day(0, { delivered: 12, dead: 1, blocked: 1 })], 2, NOW);
    render(<DeliveryChart model={model} />);

    // No tooltip until a column is hovered.
    expect(screen.queryByRole("status")).toBeNull();

    const hits = document.querySelectorAll("[data-chart-hit]");
    expect(hits).toHaveLength(2); // Jul 6 (empty), Jul 7 (today)
    fireEvent.mouseEnter(hits[1]!); // today

    const tip = screen.getByRole("status");
    expect(within(tip).getByText("Jul 7")).toBeInTheDocument();
    expect(within(tip).getByText("12")).toBeInTheDocument(); // delivered
    expect(within(tip).getByText("2")).toBeInTheDocument(); // failed = 1 dead + 1 blocked
    // (Clearing on mouse-leave is a motion exit transition — verified visually, not in jsdom.)
  });

  it("targets each day column with a full-height hit area", () => {
    const model = buildDashboardChart(
      [day(0, { delivered: 5 }), day(1, { delivered: 3 }), day(2, { delivered: 8 })],
      3,
      NOW,
    );
    render(<DeliveryChart model={model} />);
    fireEvent.mouseEnter(document.querySelectorAll("[data-chart-hit]")[0]!); // oldest = Jul 5
    expect(within(screen.getByRole("status")).getByText("Jul 5")).toBeInTheDocument();
  });
});
