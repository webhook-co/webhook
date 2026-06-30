import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Calendar, type CalendarRange } from "./calendar";

const TODAY = "2026-06-15";

function Harness({ initial = {} as CalendarRange }: { initial?: CalendarRange }) {
  const [value, setValue] = React.useState<CalendarRange>(initial);
  return <Calendar value={value} onChange={setValue} today={TODAY} />;
}

describe("Calendar", () => {
  it("opens on the month of today (or the range end) and labels it", () => {
    render(<Harness />);
    expect(screen.getByText("June 2026")).toBeInTheDocument();
  });

  it("navigates months with the prev/next controls", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Next month"));
    expect(screen.getByText("July 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Previous month"));
    await userEvent.click(screen.getByLabelText("Previous month"));
    expect(screen.getByText("May 2026")).toBeInTheDocument();
  });

  it("selects a range: first click sets the start, second sets the end", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Calendar value={{}} onChange={onChange} today={TODAY} />);
    await userEvent.click(screen.getByRole("gridcell", { name: "2026-06-10" }));
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-06-10" });

    rerender(<Calendar value={{ from: "2026-06-10" }} onChange={onChange} today={TODAY} />);
    await userEvent.click(screen.getByRole("gridcell", { name: "2026-06-20" }));
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-06-10", to: "2026-06-20" });
  });

  it("restarts the range when the second click lands before the pending start", async () => {
    const onChange = vi.fn();
    render(<Calendar value={{ from: "2026-06-20" }} onChange={onChange} today={TODAY} />);
    await userEvent.click(screen.getByRole("gridcell", { name: "2026-06-05" }));
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-06-05" });
  });

  it("starts a fresh range when a complete range already exists", async () => {
    const onChange = vi.fn();
    render(
      <Calendar
        value={{ from: "2026-06-01", to: "2026-06-10" }}
        onChange={onChange}
        today={TODAY}
      />,
    );
    await userEvent.click(screen.getByRole("gridcell", { name: "2026-06-25" }));
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-06-25" });
  });

  it("marks the range endpoints as pressed", () => {
    render(
      <Calendar
        value={{ from: "2026-06-10", to: "2026-06-20" }}
        onChange={() => {}}
        today={TODAY}
      />,
    );
    expect(screen.getByRole("gridcell", { name: "2026-06-10" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "2026-06-15" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
