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
// The sidebar (AppNav) is a client component that reads the active route via usePathname.
vi.mock("next/navigation", () => ({ usePathname: () => "/endpoints" }));

import AppLayout from "./layout";

describe("AppLayout (gated dashboard shell)", () => {
  it("renders the shell, nav, and account control around the page when the session is valid", async () => {
    render(await AppLayout({ children: <p>page content</p> }));
    expect(screen.getByText("page content")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Endpoints" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    // Credentials is its own top-level nav entry (moved out of Settings).
    expect(screen.getByRole("link", { name: "Credentials" })).toBeInTheDocument();
    // Team (collaboration) sits in the Account section too.
    expect(screen.getByRole("link", { name: "Team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  });

  it("orders the Account section Credentials → Team → Audit log → Settings", async () => {
    render(await AppLayout({ children: <p>page content</p> }));
    const links = screen.getAllByRole("link").map((l) => l.textContent);
    const credentials = links.indexOf("Credentials");
    const team = links.indexOf("Team");
    const audit = links.indexOf("Audit log");
    const settings = links.indexOf("Settings");
    expect(credentials).toBeGreaterThanOrEqual(0);
    expect(team).toBe(credentials + 1);
    expect(audit).toBe(team + 1);
    expect(settings).toBe(audit + 1);
  });

  it("groups the nav Inbound/Outbound and orders Destinations before Deliveries", async () => {
    render(await AppLayout({ children: <p>page content</p> }));
    // The sidebar reads inbound (what you receive) → outbound targets → outbound results.
    expect(screen.getByText("Inbound")).toBeInTheDocument();
    expect(screen.getByText("Outbound")).toBeInTheDocument();

    const links = screen.getAllByRole("link").map((l) => l.textContent);
    const destinations = links.indexOf("Destinations");
    const deliveries = links.indexOf("Deliveries");
    expect(destinations).toBeGreaterThanOrEqual(0);
    expect(deliveries).toBeGreaterThanOrEqual(0);
    // A delivery can't exist before a destination — Destinations comes first.
    expect(destinations).toBeLessThan(deliveries);
  });
});
