import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

import { RenameOrgCard } from "./rename-org-card";

const props = (over: Partial<Parameters<typeof RenameOrgCard>[0]> = {}) => ({
  slug: "acme",
  name: "Acme",
  rename: vi.fn(async () => ({ ok: false as const, error: "" })),
  canRename: true,
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("RenameOrgCard", () => {
  it("shows a live validation error for a bad slug and disables save", async () => {
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);

    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "no"); // too short

    expect(screen.getByText(/at least 3/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("catches a reserved slug live — and says it's reserved, not malformed", async () => {
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);

    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "settings");

    expect(screen.getByText(/reserved/i)).toBeInTheDocument();
  });

  it("submits name + slug and renders a server error inline", async () => {
    const rename = vi.fn(async () => ({
      ok: false as const,
      error: "That URL is already taken. Try another.",
    }));
    const user = userEvent.setup();
    render(<RenameOrgCard {...props({ rename })} />);

    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "acme-new");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    const fd = rename.mock.calls[0]![0] as FormData;
    expect(fd.get("slug")).toBe("acme-new");
    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
  });

  it("keeps save disabled when nothing has changed", () => {
    render(<RenameOrgCard {...props()} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("is READ-ONLY for a member — no save button, inputs disabled", () => {
    render(<RenameOrgCard {...props({ canRename: false })} />);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("URL")).toBeDisabled();
  });

  it("lowercases slug input as you type (the DB is case-sensitive on the URL)", async () => {
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);
    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "ACME-New");
    expect(url).toHaveValue("acme-new");
  });
});
