import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "./button";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(() => vi.clearAllMocks());

describe("ConfirmDialog", () => {
  it("stays closed until the trigger is clicked", () => {
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete account</Button>}
        title="Delete account"
        formAction={vi.fn()}
        confirmLabel="Permanently delete"
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a modal labelled by its title and described by its description", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete account</Button>}
        title="Delete account"
        description="This cannot be undone."
        formAction={vi.fn()}
        confirmLabel="Permanently delete"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Delete account");
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
  });

  it("without a confirmText, the confirm button submits the action immediately", async () => {
    const formAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Remove</Button>}
        title="Remove destination"
        formAction={formAction}
        confirmLabel="Remove"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove" })); // the confirm button in the modal
    await waitFor(() => expect(formAction).toHaveBeenCalledOnce());
  });

  it("closes after the action completes, so a non-redirecting reuse can't double-submit", async () => {
    const formAction = vi.fn(async () => {}); // resolves without navigating away
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Open remove</Button>}
        title="Remove destination"
        formAction={formAction}
        confirmLabel="Remove"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open remove" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(formAction).toHaveBeenCalledOnce());
    // The modal dismisses itself once the action settles — no lingering enabled confirm to click twice.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("with a confirmText, the confirm button is disabled until the EXACT word is typed", async () => {
    const formAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete account</Button>}
        title="Delete account"
        formAction={formAction}
        confirmText="DELETE"
        confirmLabel="Permanently delete my account"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    const confirm = screen.getByRole("button", { name: "Permanently delete my account" });
    expect(confirm).toBeDisabled();

    const input = screen.getByRole("textbox");
    await user.type(input, "delete"); // wrong case
    expect(confirm).toBeDisabled();

    await user.clear(input);
    await user.type(input, "DELETE"); // exact
    expect(confirm).toBeEnabled();
  });

  it("submits the typed value under the `confirm` field name (the server re-checks it)", async () => {
    const formAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete account</Button>}
        title="Delete account"
        formAction={formAction}
        confirmText="DELETE"
        confirmLabel="Permanently delete my account"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(formAction).toHaveBeenCalledOnce());
    const fd = formAction.mock.calls[0]![0] as FormData;
    expect(fd.get("confirm")).toBe("DELETE");
  });

  it("Cancel closes the modal without invoking the action", async () => {
    const formAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete account</Button>}
        title="Delete account"
        formAction={formAction}
        confirmText="DELETE"
        confirmLabel="Permanently delete my account"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(formAction).not.toHaveBeenCalled();
  });

  it("resets the typed confirmation when the modal is closed and reopened", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete account</Button>}
        title="Delete account"
        formAction={vi.fn()}
        confirmText="DELETE"
        confirmLabel="Permanently delete my account"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByRole("textbox"), "DELETE");
    expect(screen.getByRole("button", { name: "Permanently delete my account" })).toBeEnabled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Delete account" }));
    // Reopened clean: the field is empty again and confirm is disabled — no stale "DELETE" carried over.
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Permanently delete my account" })).toBeDisabled();
  });
});
