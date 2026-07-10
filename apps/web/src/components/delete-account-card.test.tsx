import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/account-actions", () => ({ deleteAccount: vi.fn() }));

import { DeleteAccountCard } from "./delete-account-card";

describe("DeleteAccountCard", () => {
  const reveal = () => fireEvent.click(screen.getByRole("button", { name: /^delete account/i }));

  it("hides the type-to-confirm form until the reveal button is clicked", () => {
    render(<DeleteAccountCard />);
    expect(screen.queryByLabelText(/to confirm/i)).not.toBeInTheDocument();
    reveal();
    expect(screen.getByLabelText(/to confirm/i)).toBeInTheDocument();
  });

  it("keeps the permanent-delete submit disabled until DELETE is typed exactly", () => {
    render(<DeleteAccountCard />);
    reveal();
    const submit = screen.getByRole("button", { name: /permanently delete my account/i });
    const input = screen.getByLabelText(/to confirm/i);

    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "delete" } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(submit).toBeEnabled();
  });

  it("cancel closes the form and resets the typed confirmation", () => {
    render(<DeleteAccountCard />);
    reveal();
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByLabelText(/to confirm/i)).not.toBeInTheDocument();

    reveal();
    expect(screen.getByLabelText(/to confirm/i)).toHaveValue("");
  });
});
