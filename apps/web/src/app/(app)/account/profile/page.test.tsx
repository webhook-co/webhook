import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { verifySession } = vi.hoisted(() => ({
  verifySession: vi.fn(async () => ({ user: { name: "Dana Doe", email: "dana@example.com" } })),
}));
vi.mock("@/server/session", () => ({ verifySession }));
// The delete card imports a server action; stub it so this server-component render stays pure.
vi.mock("@/components/delete-account-card", () => ({
  DeleteAccountCard: () => <div>delete-account-card</div>,
}));

import AccountProfilePage from "./page";

describe("account/profile page", () => {
  it("renders the profile (name + email) and the delete-account card", async () => {
    render(await AccountProfilePage());
    expect(screen.getByText("Dana Doe")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(screen.getByText("delete-account-card")).toBeInTheDocument();
    // The page heading is "Profile" (it's the profile route now, not the account index)…
    expect(screen.getByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
    // …and it appears exactly ONCE — the identity card no longer repeats a "Profile" title under the h1.
    expect(screen.getAllByText("Profile")).toHaveLength(1);
  });

  it("gates on the session — the page must call verifySession (a mocked gate is only tested if we assert it ran)", async () => {
    render(await AccountProfilePage());
    expect(verifySession).toHaveBeenCalled();
  });
});
