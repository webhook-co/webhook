import type { ConnectedApp } from "@webhook-co/contract";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConnectedAppsManager } from "./connected-apps-manager";

const app = (over: Partial<ConnectedApp> = {}): ConnectedApp => ({
  grantId: "grant_1",
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  clientName: "Claude Code",
  identityDomain: "claude.ai",
  verified: true,
  scopes: ["events:read", "endpoints:write"],
  createdAt: 1_760_000_000,
  ...over,
});

describe("ConnectedAppsManager", () => {
  it("renders each app with name, verified badge, identity domain, and scopes", () => {
    render(<ConnectedAppsManager initialApps={[app()]} revoke={vi.fn()} />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
    expect(screen.getByText("claude.ai")).toBeInTheDocument();
    expect(screen.getByText("events:read")).toBeInTheDocument();
    expect(screen.getByText("endpoints:write")).toBeInTheDocument();
  });

  it("shows an unverified app with its 'no verified domain' fallback", () => {
    render(
      <ConnectedAppsManager
        initialApps={[app({ clientName: "Some App", identityDomain: null, verified: false })]}
        revoke={vi.fn()}
      />,
    );
    expect(screen.getByText(/^unverified$/i)).toBeInTheDocument();
    expect(screen.getByText(/no verified domain/i)).toBeInTheDocument();
  });

  it("shows the bound org (name + slug) each app can see", () => {
    render(
      <ConnectedAppsManager
        initialApps={[app({ org: { id: "org_1", slug: "acme", name: "Acme Inc" } })]}
        revoke={vi.fn()}
      />,
    );
    expect(screen.getByText(/Organization: Acme Inc \(acme\)/)).toBeInTheDocument();
  });

  it("shows 'unknown org' for a legacy grant with no bound org", () => {
    render(<ConnectedAppsManager initialApps={[app()]} revoke={vi.fn()} />); // no org
    expect(screen.getByText(/Organization: unknown organization/)).toBeInTheDocument();
  });

  it("revokes an app through the confirm dialog and removes it from the list", async () => {
    const revoke = vi.fn().mockResolvedValue({ ok: true });
    render(<ConnectedAppsManager initialApps={[app()]} revoke={revoke} />);

    await userEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /revoke access/i }));

    expect(revoke).toHaveBeenCalledWith("grant_1");
    // the app is removed → empty state copy appears
    expect(await screen.findByText(/no apps are connected/i)).toBeInTheDocument();
  });

  it("surfaces an error and keeps the app when revoke fails", async () => {
    const revoke = vi.fn().mockResolvedValue({ ok: false, error: "nope, try again" });
    render(<ConnectedAppsManager initialApps={[app()]} revoke={revoke} />);
    await userEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /revoke access/i }));
    expect(await screen.findByText(/nope, try again/i)).toBeInTheDocument();
    // still listed (the name also appears in the still-open dialog, hence getAllByText)
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  });

  it("renders the empty state when there are no connected apps", () => {
    render(<ConnectedAppsManager initialApps={[]} revoke={vi.fn()} />);
    expect(screen.getByText(/no apps are connected/i)).toBeInTheDocument();
  });
});
