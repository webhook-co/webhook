import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// SubmitButton reads useFormStatus. Mock it so we can drive the pending state without a real form submission.
const useFormStatus = vi.fn();
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => useFormStatus(),
}));

import { SubmitButton } from "./submit-button";

describe("SubmitButton", () => {
  it("is an ordinary submit button when the form is idle", () => {
    useFormStatus.mockReturnValue({ pending: false });
    render(<SubmitButton>Delete my account</SubmitButton>);

    const btn = screen.getByRole("button", { name: /delete my account/i });
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn).not.toBeDisabled();
  });

  // The reason it exists: these forms submit a SERVER ACTION with no feedback, and "delete my account" is not
  // an action you want fired twice because the first click looked dead.
  it("shows busy and is un-clickable while its form's action is in flight", () => {
    useFormStatus.mockReturnValue({ pending: true });
    render(<SubmitButton>Delete my account</SubmitButton>);

    const btn = screen.getByRole("button", { name: /delete my account/i });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toBeDisabled();
  });

  it("respects the caller's own disabled (the type-DELETE gate) while idle", () => {
    useFormStatus.mockReturnValue({ pending: false });
    render(<SubmitButton disabled>Delete</SubmitButton>);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
