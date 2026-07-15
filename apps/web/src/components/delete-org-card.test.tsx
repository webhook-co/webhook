import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The card imports a server action; stub the module so the client component renders in jsdom.
const { deleteOrganization } = vi.hoisted(() => ({ deleteOrganization: vi.fn() }));
vi.mock("@/server/org-actions", () => ({ deleteOrganization }));

import { DeleteOrgCard } from "./delete-org-card";

afterEach(() => vi.clearAllMocks());

describe("DeleteOrgCard", () => {
  it("the trigger is a plain 'Delete organization' — no ellipsis (the modal confirms)", () => {
    render(<DeleteOrgCard slug="acme" />);
    const trigger = screen.getByRole("button", { name: "Delete organization" });
    expect(trigger).toBeInTheDocument();
    expect(trigger.textContent).not.toMatch(/…|\.\.\./);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a confirmation modal that gates deletion behind typing DELETE", async () => {
    const user = userEvent.setup();
    render(<DeleteOrgCard slug="acme" />);

    await user.click(screen.getByRole("button", { name: "Delete organization" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Permanently delete" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "delete"); // wrong case must not enable
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "DELETE");
    expect(confirm).toBeEnabled();
  });

  it("submits the bound slug AND confirm=DELETE to the deleteOrganization server action", async () => {
    const user = userEvent.setup();
    render(<DeleteOrgCard slug="acme" />);

    await user.click(screen.getByRole("button", { name: "Delete organization" }));
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await waitFor(() => expect(deleteOrganization).toHaveBeenCalledOnce());
    // The action is `deleteOrganization.bind(null, slug)`, so the slug is the first arg and FormData the second.
    const [slug, fd] = deleteOrganization.mock.calls[0]! as [string, FormData];
    expect(slug).toBe("acme");
    expect(fd.get("confirm")).toBe("DELETE");
  });
});
