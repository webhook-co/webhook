import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/org-access", () => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "usr_1",
    orgId: "org_1",
    // The CANONICAL slug the gate resolved from the URL — every link the shell renders is rooted at it.
    slug: "acme",
    role: "owner",
    user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
  })),
}));
vi.mock("@/server/auth-actions", () => ({ logout: vi.fn() }));
// The org switcher's data. It has its own gate (verifySession → cookies()), which has no request scope in a
// unit test — the layout's own gate is mocked above, and this is the other read the layout performs.
vi.mock("@/server/my-orgs", () => ({
  loadMyOrgs: vi.fn(async () => ({
    orgs: [{ orgId: "org_1", slug: "acme", name: "Acme", role: "owner" }],
    currentOrgId: "org_1",
  })),
}));
// The sidebar (AppNav) is a client component that reads the active route via usePathname.
// The layout now also mounts the ⌘K palette, which routes via useRouter.
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  usePathname: () => "/org/acme/endpoints",
  useRouter: () => ({ push: vi.fn() }),
}));

import AppLayout from "./layout";

describe("AppLayout (gated dashboard shell)", () => {
  it("renders the shell, nav, and account control around the page when the session is valid", async () => {
    render(
      await AppLayout({ children: <p>page content</p>, params: Promise.resolve({ slug: "acme" }) }),
    );
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
    render(
      await AppLayout({ children: <p>page content</p>, params: Promise.resolve({ slug: "acme" }) }),
    );
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
    render(
      await AppLayout({ children: <p>page content</p>, params: Promise.resolve({ slug: "acme" }) }),
    );
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
