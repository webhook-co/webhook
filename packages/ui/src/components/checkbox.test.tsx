import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("renders an unchecked checkbox by default", () => {
    render(<Checkbox aria-label="Accept terms" />);
    expect(screen.getByRole("checkbox", { name: "Accept terms" })).not.toBeChecked();
  });

  it("reflects a controlled checked state", () => {
    render(<Checkbox aria-label="Accept terms" checked />);
    expect(screen.getByRole("checkbox", { name: "Accept terms" })).toBeChecked();
  });

  it("toggles and fires onCheckedChange when clicked", async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept terms" onCheckedChange={onCheckedChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Accept terms" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("checkbox", { name: "Accept terms" })).toBeChecked();
  });

  it("toggles with the Space key", async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept terms" onCheckedChange={onCheckedChange} />);
    screen.getByRole("checkbox", { name: "Accept terms" }).focus();
    await userEvent.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle when disabled", async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept terms" disabled onCheckedChange={onCheckedChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Accept terms" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("exposes an indeterminate state as aria-checked=mixed", () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" />);
    expect(screen.getByRole("checkbox", { name: "Select all" })).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
  });

  it("forwards a ref to the underlying control", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Checkbox aria-label="Accept terms" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
