import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Input, Label } from "./input";

describe("Input", () => {
  it("renders a text input by default", () => {
    render(<Input aria-label="endpoint url" />);
    expect(screen.getByLabelText("endpoint url")).toHaveAttribute("type", "text");
  });

  it("accepts typed input", async () => {
    render(<Input aria-label="name" />);
    const input = screen.getByLabelText<HTMLInputElement>("name");
    await userEvent.type(input, "prod");
    expect(input.value).toBe("prod");
  });

  it("associates a label with its control via htmlFor", () => {
    render(
      <>
        <Label htmlFor="secret">Signing secret</Label>
        <Input id="secret" />
      </>,
    );
    expect(screen.getByLabelText("Signing secret")).toBeInTheDocument();
  });

  it("carries the invalid-state border class when aria-invalid is set", () => {
    render(<Input aria-label="bad url" aria-invalid />);
    const input = screen.getByLabelText("bad url");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("aria-[invalid=true]:border-danger-border");
  });

  it("is disabled and non-interactive when disabled", () => {
    render(<Input aria-label="locked" disabled />);
    expect(screen.getByLabelText("locked")).toBeDisabled();
  });

  it("forwards an explicit type (e.g. password)", () => {
    render(<Input aria-label="secret" type="password" />);
    expect(screen.getByLabelText("secret")).toHaveAttribute("type", "password");
  });
});
