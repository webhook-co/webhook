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

import AppLayout from "./layout";

describe("AppLayout (gated dashboard shell)", () => {
  it("renders the shell, nav, and account control around the page when the session is valid", async () => {
    render(await AppLayout({ children: <p>page content</p> }));
    expect(screen.getByText("page content")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  });
});
