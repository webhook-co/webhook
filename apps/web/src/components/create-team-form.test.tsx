import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateTeamForm } from "./create-team-form";

afterEach(() => vi.clearAllMocks());

describe("CreateTeamForm", () => {
  it("previews the derived URL as you type the name", async () => {
    const user = userEvent.setup();
    render(<CreateTeamForm create={vi.fn(async () => ({ ok: false as const, error: "" }))} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme Engineering");
    // The preview shows the slugified base of the name (the server may add a suffix).
    expect(screen.getByText(/webhook\.co\/org\/acme-engineering/i)).toBeInTheDocument();
  });

  it("submits the trimmed name and renders a server error inline", async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      error: "We couldn't create the team.",
    }));
    const user = userEvent.setup();
    render(<CreateTeamForm create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "  Acme  ");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect((create.mock.calls[0]![0] as FormData).get("name")).toBe("Acme");
    expect(await screen.findByText(/couldn't create/i)).toBeInTheDocument();
  });

  it("keeps the button disabled for an empty / whitespace-only name", async () => {
    const user = userEvent.setup();
    render(<CreateTeamForm create={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
    await user.type(screen.getByLabelText("Organization name"), "   ");
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
  });
});
