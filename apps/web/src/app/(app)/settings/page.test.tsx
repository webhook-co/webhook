import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  verifySession: vi.fn(async () => ({
    userId: "usr_1",
    orgId: "org_1",
    user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
  })),
}));
vi.mock("@/server/auth-actions", () => ({ logout: vi.fn() }));

import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("renders the signed-in account and a logout control from the session", async () => {
    render(await SettingsPage());
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Dana Kessler")).toBeInTheDocument();
    expect(screen.getByText("dana@acme.co")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});
