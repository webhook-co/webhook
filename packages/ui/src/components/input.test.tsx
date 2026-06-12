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
});
