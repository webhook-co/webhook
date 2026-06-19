import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { Field } from "./field";

describe("Field", () => {
  it("renders a label associated with the input", () => {
    render(<Field label="Work email" />);
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });

  it("auto-generates an id and wires htmlFor/id when none is given", () => {
    render(<Field label="Name" />);
    const input = screen.getByLabelText<HTMLInputElement>("Name");
    expect(input.id).toBeTruthy();
  });

  it("uses a provided id", () => {
    render(<Field label="Slug" id="slug-field" />);
    expect(screen.getByLabelText("Slug")).toHaveAttribute("id", "slug-field");
  });

  it("renders a hint and points aria-describedby at it", () => {
    render(<Field label="Email" hint="We never share it." />);
    const input = screen.getByLabelText("Email");
    const hint = screen.getByText("We never share it.");
    expect(input.getAttribute("aria-describedby")).toContain(hint.id);
  });

  it("marks the field invalid and describes it by the error when an error is set", () => {
    render(<Field label="Email" error="Enter a valid email." />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByText("Enter a valid email.");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    // the error is a live region so it's announced when it appears
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email.");
  });

  it("describes the field by both the hint and the error when both are present", () => {
    render(<Field label="Email" hint="Work email preferred." error="Required." />);
    const input = screen.getByLabelText("Email");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain(screen.getByText("Work email preferred.").id);
    expect(describedBy).toContain(screen.getByText("Required.").id);
  });

  it("is not marked invalid when there is no error", () => {
    render(<Field label="Email" />);
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("forwards input props (type, placeholder, disabled) and accepts typed input", async () => {
    render(<Field label="Email" type="email" placeholder="you@company.com" />);
    const input = screen.getByLabelText<HTMLInputElement>("Email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("placeholder", "you@company.com");
    await userEvent.type(input, "a@b.co");
    expect(input.value).toBe("a@b.co");
  });

  it("forwards a ref to the underlying input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Field label="Email" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});
