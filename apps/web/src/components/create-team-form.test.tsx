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

  it("submits just the trimmed name for an untouched URL (the server derives the slug), and renders a server error inline", async () => {
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
    // The auto-derived preview is NOT a choice — it's omitted so the server derives a valid unique slug.
    expect(fd.get("orgSlug")).toBeNull();
    expect(await screen.findByText(/couldn't create/i)).toBeInTheDocument();
  });

  it("submits the CHOSEN URL once the user edits the field", async () => {
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    const urlField = screen.getByLabelText("Organization URL");
    await user.clear(urlField);
    await user.type(urlField, "widgets"); // the user takes the URL over
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const fd = create.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("Acme");
    expect(fd.get("orgSlug")).toBe("widgets"); // the chosen URL rides along verbatim
  });

  it("still submits a name that slugifies to nothing — the server derives the slug, no dead-end", async () => {
    // A purely-symbolic name derives an empty slug. The old name-only form accepted it (server suffixed a
    // slug); requiring the derived slug would trap the user on a URL error they never asked for. It must submit.
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "!!!");
    const button = screen.getByRole("button", { name: "Create organization" });
    expect(button).toBeEnabled(); // no dead-end
    await user.click(button);

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const fd = create.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("!!!");
    expect(fd.get("orgSlug")).toBeNull(); // server derives it
  });

  it("still submits a short name whose derived slug would be too short — no untouched-URL error", async () => {
    // "Hi" derives "hi" (below the 3-char minimum). Because the user never touched the URL, this must NOT
    // surface a validation error or disable submit — the server derives a valid, suffixed slug instead.
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Hi");
    expect(screen.queryByText(/at least 3 characters/i)).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Create organization" });
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect((create.mock.calls[0]![0] as FormData).get("orgSlug")).toBeNull();
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
