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

  it("submits the trimmed name AND the chosen URL, and renders a server error inline", async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      error: "We couldn't create the organization.",
    }));
    const user = userEvent.setup();
    render(<CreateTeamForm create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "  Acme  ");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const fd = create.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("Acme");
    expect(fd.get("orgSlug")).toBe("acme"); // auto-derived URL rides along
    expect(await screen.findByText(/couldn't create/i)).toBeInTheDocument();
  });

  it("the URL tracks the name until you edit the URL, then stops following it", async () => {
    const user = userEvent.setup();
    render(<CreateTeamForm create={vi.fn(async () => ({ ok: false as const, error: "" }))} />);

    const nameField = screen.getByLabelText("Organization name");
    const urlField = screen.getByLabelText("Organization URL");
    await user.type(nameField, "Acme");
    expect(urlField).toHaveValue("acme"); // tracked from the name

    await user.clear(urlField);
    await user.type(urlField, "widgets"); // user takes the URL over
    await user.type(nameField, " Corp"); // name keeps changing…
    expect(urlField).toHaveValue("widgets"); // …but the URL no longer follows
  });

  it("disables submit and shows an inline error for an invalid URL", async () => {
    const create = vi.fn();
    const user = userEvent.setup();
    render(<CreateTeamForm create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    const urlField = screen.getByLabelText("Organization URL");
    await user.clear(urlField);
    await user.type(urlField, "Nope!!"); // uppercase + illegal chars → invalid slug
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create organization" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the button disabled for an empty / whitespace-only name", async () => {
    const user = userEvent.setup();
    render(<CreateTeamForm create={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
    await user.type(screen.getByLabelText("Organization name"), "   ");
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
  });
});
