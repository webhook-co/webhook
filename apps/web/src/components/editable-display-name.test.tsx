import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { EditableDisplayName } from "./editable-display-name";

afterEach(() => vi.clearAllMocks());

const ok = vi.fn(async () => ({ ok: true as const }));

describe("EditableDisplayName", () => {
  it("shows the name, email, and an Edit button in view mode (no input)", () => {
    render(<EditableDisplayName name="Dana Doe" email="dana@example.com" onSave={ok} />);
    expect(screen.getByText("Dana Doe")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("edits, saves the trimmed name, and refreshes so the re-minted name shows everywhere", async () => {
    const user = userEvent.setup();
    render(<EditableDisplayName name="Dana Doe" email="dana@example.com" onSave={ok} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("Dana Doe"); // pre-filled with the current name
    await user.clear(input);
    await user.type(input, "  Dana Kessler  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(ok).toHaveBeenCalledOnce());
    expect((ok.mock.calls[0]![0] as FormData).get("name")).toBe("Dana Kessler"); // trimmed
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledOnce()); // re-render with the new cookie
    // Back to view mode.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps the editor open and shows the error when the save fails", async () => {
    const fail = vi.fn(async () => ({
      ok: false as const,
      error: "We couldn't update your name.",
    }));
    const user = userEvent.setup();
    render(<EditableDisplayName name="Dana Doe" email="dana@example.com" onSave={fail} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/couldn't update your name/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument(); // still editing
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("disables Save for an empty/whitespace name", async () => {
    const user = userEvent.setup();
    render(<EditableDisplayName name="Dana Doe" email="dana@example.com" onSave={ok} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "   ");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("Cancel returns to view mode without saving", async () => {
    const user = userEvent.setup();
    render(<EditableDisplayName name="Dana Doe" email="dana@example.com" onSave={ok} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Discarded");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Dana Doe")).toBeInTheDocument();
    expect(ok).not.toHaveBeenCalled();
  });
});
