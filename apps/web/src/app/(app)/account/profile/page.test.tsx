import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  verifySession: vi.fn(async () => ({ user: { name: "Dana Doe", email: "dana@example.com" } })),
}));
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
    // The page heading is "Profile" (it's the profile route now, not the account index).
    expect(screen.getByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
  });
});
