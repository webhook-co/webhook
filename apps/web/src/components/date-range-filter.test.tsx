import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateRangeFilter, type DateRangeValue } from "./date-range-filter";

// Unmount each render between tests so a prior test's Radix popover portal doesn't linger in the jsdom
// body and pollute the next test's body-wide `getAllByRole("gridcell")` queries.
afterEach(cleanup);

function open(value: DateRangeValue, onApply = vi.fn()) {
  render(<DateRangeFilter value={value} onApply={onApply} />);
  return { onApply };
}

const EMPTY: DateRangeValue = { range: "", from: "", to: "" };

describe("DateRangeFilter", () => {
  it("labels the trigger from the active range", () => {
    const { rerender } = render(<DateRangeFilter value={EMPTY} onApply={() => {}} />);
    expect(screen.getByText("Date range")).toBeInTheDocument();
    rerender(<DateRangeFilter value={{ range: "7d", from: "", to: "" }} onApply={() => {}} />);
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    rerender(
      <DateRangeFilter value={{ range: "", from: "2026-06-01", to: "" }} onApply={() => {}} />,
    );
    expect(screen.getByText("Custom range")).toBeInTheDocument();
  });

  it("hosts presets AND a calendar in one popover (no separate row)", async () => {
    open(EMPTY);
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    expect(screen.getByRole("button", { name: "Last 7 days" })).toBeInTheDocument();
    // The calendar is present in the same popover.
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });

  it("picking a preset applies it and clears any custom dates", async () => {
    const { onApply } = open(EMPTY);
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    await userEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
    expect(onApply).toHaveBeenCalledWith({ range: "24h", from: "", to: "" });
  });

  it("marks the active preset with a check", async () => {
    open({ range: "7d", from: "", to: "" });
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    // The active preset's row carries the check icon (the others don't).
    const sevenDays = screen.getByRole("button", { name: "Last 7 days" });
    expect(sevenDays.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last hour" }).querySelector("svg")).toBeNull();
  });

  it("selecting a calendar day clears the preset and sets the custom from-bound", async () => {
    const { onApply } = open({ range: "7d", from: "", to: "" });
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    // Pick any day in the shown month — it starts a custom range and clears the preset.
    const dayCells = screen.getAllByRole("gridcell");
    await userEvent.click(dayCells[10]!);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ range: "", to: "" }));
    expect(onApply.mock.calls[0]![0].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("maps the inclusive calendar end to the EXCLUSIVE wire bound (clicked day + 1)", async () => {
    // from is already set; clicking the end day (Jun 20) means "include Jun 20", so the exclusive `?to=`
    // is Jun 21 — keeping the wire semantics identical to the CLI `--before` (parity), inclusive on screen.
    const { onApply } = open({ range: "", from: "2026-06-10", to: "" });
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    await userEvent.click(screen.getByRole("gridcell", { name: "2026-06-20" }));
    expect(onApply).toHaveBeenCalledWith({ from: "2026-06-10", to: "2026-06-21", range: "" });
  });

  it("reads a seeded wire range back inclusively (exclusive ?to= → calendar end = to − 1)", async () => {
    // Wire from=Jun 10 / to=Jun 21 (exclusive) means "Jun 10 through Jun 20 inclusive" → the calendar
    // highlights Jun 10 and Jun 20 as the endpoints.
    open({ range: "", from: "2026-06-10", to: "2026-06-21" });
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    expect(screen.getByRole("gridcell", { name: "2026-06-10" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "2026-06-20" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "2026-06-21" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("a valid preset HIGHLIGHTS its own resolved range in the calendar (ignoring stray from/to)", async () => {
    // The preset OWNS the range: the calendar shows the preset's [now−window, today] span (NOT the stray
    // from/to). `today` is the preset's `to`, in the opened month, so it's a pressed endpoint.
    open({ range: "7d", from: "2020-01-01", to: "2020-01-10" });
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const todayYmd = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
    expect(screen.getByRole("gridcell", { name: todayYmd })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Filter by received date: Last 7 days" }),
    ).toBeInTheDocument();
  });
});
