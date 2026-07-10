import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The card imports a server action; stub the module so the client component renders in jsdom.
vi.mock("@/server/org-actions", () => ({ deleteOrganization: vi.fn() }));

import { DeleteOrgCard } from "./delete-org-card";

describe("DeleteOrgCard", () => {
  const reveal = () =>
    fireEvent.click(screen.getByRole("button", { name: /delete organization/i }));

  it("hides the type-to-confirm form until the reveal button is clicked", () => {
    render(<DeleteOrgCard />);
    expect(screen.queryByLabelText(/to confirm/i)).not.toBeInTheDocument();
    reveal();
    expect(screen.getByLabelText(/to confirm/i)).toBeInTheDocument();
  });

  it("keeps the permanent-delete submit disabled until DELETE is typed exactly", () => {
    render(<DeleteOrgCard />);
    reveal();
    const submit = screen.getByRole("button", { name: /permanently delete/i });
    const input = screen.getByLabelText(/to confirm/i);

    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "delete" } }); // wrong case must not enable
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(submit).toBeEnabled();
  });

  it("cancel closes the form and resets the typed confirmation", () => {
    render(<DeleteOrgCard />);
    reveal();
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByLabelText(/to confirm/i)).not.toBeInTheDocument();

    reveal();
    expect(screen.getByLabelText(/to confirm/i)).toHaveValue("");
  });
});
