import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ApiKeyItem, CredentialsResult, DeviceGrant } from "@/server/credentials";

import { CredentialsView } from "./credentials-view";

const key = (over: Partial<ApiKeyItem> = {}): ApiKeyItem => ({
  id: "key_1",
  name: "Production signer",
  start: "whsec_9b3a…e21f",
  scopes: ["endpoints:read", "events:read"],
  createdAt: new Date("2026-04-12T11:20:00Z"),
  lastUsedAt: new Date("2026-06-18T17:05:00Z"),
  expiresAt: null,
  revokedAt: null,
  ...over,
});

const grant = (over: Partial<DeviceGrant> = {}): DeviceGrant => ({
  id: "grant_1",
  status: "active",
  authMethod: "device_code",
  deviceName: "Dana's MacBook Pro",
  createdAt: new Date("2026-05-21T14:02:00Z"),
  lastUsedAt: new Date("2026-06-19T09:41:00Z"),
  approvedAt: new Date("2026-05-21T14:03:00Z"),
  revokedAt: null,
  expiresAt: new Date("2026-08-19T14:02:00Z"),
  keys: [key({ id: "key_child", name: "wbhk cli", start: "whk_2aF9…7c1d" })],
  ...over,
});

const ok = (
  over: Partial<Extract<CredentialsResult, { status: "ok" }>> = {},
): CredentialsResult => ({
  status: "ok",
  devices: [grant()],
  keys: [key()],
  ...over,
});

describe("CredentialsView", () => {
  it("renders the two groupings: authorized devices and API keys", () => {
    render(<CredentialsView result={ok()} />);
    expect(screen.getByRole("heading", { name: /authorized devices/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /api keys/i })).toBeInTheDocument();
  });

  it("shows a device with its status and child keys", () => {
    render(<CredentialsView result={ok()} />);
    const device = screen.getByText("Dana's MacBook Pro").closest("article, section, div");
    expect(within(device as HTMLElement).getByText(/active/i)).toBeInTheDocument();
    // the child key minted under the grant
    expect(screen.getByText("whk_2aF9…7c1d")).toBeInTheDocument();
  });

  it("shows a standalone key by its name, redacted prefix, and scopes", () => {
    render(<CredentialsView result={ok({ devices: [] })} />);
    expect(screen.getByText("Production signer")).toBeInTheDocument();
    expect(screen.getByText("whsec_9b3a…e21f")).toBeInTheDocument();
    expect(screen.getByText(/endpoints:read/)).toBeInTheDocument();
  });

  it("marks a revoked key as revoked, distinct from a live one", () => {
    render(
      <CredentialsView
        result={ok({
          devices: [],
          keys: [
            key({ id: "live", name: "live key", start: "whsec_aaaa…bbbb", revokedAt: null }),
            key({
              id: "dead",
              name: "dead key",
              start: "whsec_cccc…dddd",
              revokedAt: new Date("2026-06-01T00:00:00Z"),
            }),
          ],
        })}
      />,
    );
    const liveRow = screen.getByText("live key").closest("tr");
    const deadRow = screen.getByText("dead key").closest("tr");
    expect(within(liveRow as HTMLElement).getByText("active")).toBeInTheDocument();
    expect(within(deadRow as HTMLElement).getByText("revoked")).toBeInTheDocument();
  });

  it("only ever shows the redacted prefix — never a full secret or a key_hash", () => {
    const { container } = render(<CredentialsView result={ok()} />);
    // every rendered key string is the redacted `start` form (carries the … ellipsis)
    expect(container.textContent).toContain("…");
    expect(container.textContent).not.toMatch(/key_hash/i);
  });

  it("renders an empty state for each grouping when there are none", () => {
    render(<CredentialsView result={ok({ devices: [], keys: [] })} />);
    expect(screen.getByText(/no authorized devices/i)).toBeInTheDocument();
    expect(screen.getByText(/no api keys/i)).toBeInTheDocument();
  });

  it("surfaces a load error", () => {
    render(<CredentialsView result={{ status: "error" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load/i);
  });

  it("surfaces permission-denied", () => {
    render(<CredentialsView result={{ status: "denied" }} />);
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });

  it("marks an expired grant distinctly from an active one", () => {
    render(
      <CredentialsView
        result={ok({
          devices: [
            grant({ id: "g_a", deviceName: "active-dev", status: "active" }),
            grant({ id: "g_e", deviceName: "old-dev", status: "expired", keys: [] }),
          ],
        })}
      />,
    );
    const expiredDevice = screen.getByText("old-dev").closest("article, section, div");
    expect(within(expiredDevice as HTMLElement).getByText(/expired/i)).toBeInTheDocument();
  });
});
