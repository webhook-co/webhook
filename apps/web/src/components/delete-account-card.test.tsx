import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { deleteAccount } = vi.hoisted(() => ({ deleteAccount: vi.fn() }));
vi.mock("@/server/account-actions", () => ({ deleteAccount }));

import { DeleteAccountCard } from "./delete-account-card";

afterEach(() => vi.clearAllMocks());

describe("DeleteAccountCard", () => {
  it("the trigger is a plain 'Delete account' — no ellipsis (the modal carries the confirmation)", () => {
    render(<DeleteAccountCard />);
    const trigger = screen.getByRole("button", { name: "Delete account" });
    expect(trigger).toBeInTheDocument();
    // Guard the founder's ask: the old inline reveal used "Delete account…" (U+2026). It must be gone.
    expect(trigger.textContent).not.toMatch(/…|\.\.\./);
    // And it's a modal now, not an inline reveal: nothing is shown until the trigger is clicked.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a confirmation modal that gates deletion behind typing DELETE", async () => {
    const user = userEvent.setup();
    render(<DeleteAccountCard />);

    await user.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Permanently delete my account" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "DELETE");
    expect(confirm).toBeEnabled();
  });

  it("submits confirm=DELETE to the deleteAccount server action", async () => {
    const user = userEvent.setup();
    render(<DeleteAccountCard />);

    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledOnce());
    const fd = deleteAccount.mock.calls[0]![0] as FormData;
    expect(fd.get("confirm")).toBe("DELETE");
  });
});
