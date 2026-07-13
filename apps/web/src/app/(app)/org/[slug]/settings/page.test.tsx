import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// requireOrgAccess now carries the org's authoritative `name` (from the directory read that proved
// membership), so the page renders the rename card WITHOUT a second directory query.
vi.mock("@/server/org-access", () => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "usr_1",
    orgId: "org_1",
    slug: "acme",
    name: "Acme",
    role: "owner",
    user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
  })),
}));
vi.mock("@/server/auth-actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/org-actions", () => ({ renameOrgAction: vi.fn() }));

import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("renders the signed-in account and a logout control from the session", async () => {
    render(await SettingsPage({ params: Promise.resolve({ slug: "acme" }) }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Dana Kessler")).toBeInTheDocument();
    expect(screen.getByText("dana@acme.co")).toBeInTheDocument();
    // Log out is styled with the red danger button by deliberate product choice (matches "Delete
    // endpoint") — asserting the token class locks that intent, since it's the requirement's whole point.
    expect(screen.getByRole("button", { name: "Log out" })).toHaveClass("bg-danger");
    // The rename card is the primary org control on this page: name + URL, editable by an owner.
    expect(screen.getByLabelText("Name")).toHaveValue("Acme");
    expect(screen.getByLabelText("URL")).toHaveValue("acme");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });
});
