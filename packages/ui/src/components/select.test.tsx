import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { Select } from "./select";

describe("Select", () => {
  it("renders a native select with its options", () => {
    render(
      <Select aria-label="Provider">
        <option value="">All</option>
        <option value="stripe">stripe</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Provider" });
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "stripe" })).toBeInTheDocument();
  });

  it("reflects a controlled value and fires onChange on selection", async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Provider" value="" onChange={onChange}>
        <option value="">All</option>
        <option value="stripe">stripe</option>
      </Select>,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "stripe");
    expect(onChange).toHaveBeenCalled();
  });

  it("does not change when disabled", async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Provider" disabled onChange={onChange}>
        <option value="stripe">stripe</option>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
  });

  it("forwards a ref to the underlying select", () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select aria-label="Provider" ref={ref}>
        <option value="a">a</option>
      </Select>,
    );
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
  });
});
