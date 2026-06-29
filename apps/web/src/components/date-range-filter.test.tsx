import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { DateRangeFilter, type DateRangeValue } from "./date-range-filter";

// A stateful harness that mirrors how the filter bar wires the control: onApply merges a patch into the
// value (an empty string clears a key, exactly like the URL delete), and customOpen is parent-owned.
function Harness({
  initial = { range: "", from: "", to: "" },
  onApplySpy,
}: {
  initial?: DateRangeValue;
  onApplySpy?: (patch: Record<string, string>) => void;
}) {
  const [value, setValue] = React.useState<DateRangeValue>(initial);
  const [customOpen, setCustomOpen] = React.useState(false);
  return (
    <DateRangeFilter
      value={value}
      customOpen={customOpen}
      onCustomOpenChange={setCustomOpen}
      onApply={(patch) => {
        onApplySpy?.(patch);
        setValue((v) => ({ ...v, ...patch }));
      }}
    />
  );
}

const fromInput = () => screen.queryByLabelText("From date");

describe("DateRangeFilter", () => {
  it("defaults to 'Date range' with no custom inputs shown", () => {
    render(<Harness />);
    expect(screen.getByText("Date range")).toBeInTheDocument();
    expect(fromInput()).not.toBeInTheDocument();
  });

  it("picking a preset applies it, collapses custom, and labels the trigger", async () => {
    const onApply = vi.fn();
    render(<Harness onApplySpy={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Last 7 days" }));
    expect(onApply).toHaveBeenCalledWith({ range: "7d", from: "", to: "" });
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(fromInput()).not.toBeInTheDocument();
  });

  it("'Custom range…' reveals the inputs WITHOUT clearing an active preset (no URL write)", async () => {
    const onApply = vi.fn();
    render(<Harness initial={{ range: "7d", from: "", to: "" }} onApplySpy={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Custom range/ }));
    // Inputs appear, but the preset stays applied (label unchanged) — openCustom must not write the URL.
    expect(fromInput()).toBeInTheDocument();
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("entering a custom date clears the preset in the same push and relabels", async () => {
    const onApply = vi.fn();
    render(<Harness initial={{ range: "7d", from: "", to: "" }} onApplySpy={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by received date/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Custom range/ }));
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-06-01" } });
    expect(onApply).toHaveBeenCalledWith({ from: "2026-06-01", range: "" });
    expect(screen.getByText("Custom range")).toBeInTheDocument();
  });

  it("lets a valid preset OWN the range — stray from/to in the value don't show custom inputs", () => {
    render(<Harness initial={{ range: "7d", from: "2026-06-01", to: "" }} />);
    // Mirrors the parser (preset wins, from/to ignored): no custom inputs, no contradictory custom label.
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(fromInput()).not.toBeInTheDocument();
  });

  it("shows the inputs and a 'Custom range' label for a URL-seeded custom range", () => {
    render(<Harness initial={{ range: "", from: "2026-06-01", to: "2026-06-08" }} />);
    expect(screen.getByText("Custom range")).toBeInTheDocument();
    expect(screen.getByLabelText("From date")).toHaveValue("2026-06-01");
  });

  it("keeps the inputs mounted while editing even if both dates are emptied", () => {
    render(<Harness initial={{ range: "", from: "2026-06-01", to: "" }} />);
    const from = screen.getByLabelText("From date");
    // Clearing the only date would drop customActive to false; setCustom marks customOpen so the inputs
    // stay (the old behavior unmounted them mid-edit).
    fireEvent.change(from, { target: { value: "" } });
    expect(fromInput()).toBeInTheDocument();
  });
});
