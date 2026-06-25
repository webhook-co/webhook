import { CAPABILITY_SCOPES } from "@webhook-co/contract/capability";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CreateKeyResult } from "@/server/credential-actions";
import type { ApiKeyItem, CredentialsResult, DeviceGrant } from "@/server/credentials";

import { CredentialsManager } from "./credentials-manager";

const okResult: CredentialsResult = { status: "ok", devices: [], keys: [] };

function createdKey(plaintext: string): CreateKeyResult {
  return {
    ok: true,
    plaintext,
    key: {
      id: "key_new",
      name: "CI deploy",
      start: `${plaintext.slice(0, 11)}…${plaintext.slice(-4)}`,
      scopes: ["events:read"],
      createdAt: new Date("2026-06-20T00:00:00Z"),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    },
  };
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /create key/i }));
  return screen.getByRole("dialog");
}

describe("CredentialsManager", () => {
  it("renders a create-key affordance", () => {
    render(
      <CredentialsManager
        initialResult={okResult}
        createKey={vi.fn()}
        scopes={CAPABILITY_SCOPES}
      />,
    );
    expect(screen.getByRole("button", { name: /create key/i })).toBeInTheDocument();
  });

  it("offers exactly the five grantable scopes — never the reserved keys:manage", async () => {
    const user = userEvent.setup();
    render(
      <CredentialsManager
        initialResult={okResult}
        createKey={vi.fn()}
        scopes={CAPABILITY_SCOPES}
      />,
    );
    const dialog = await openCreateDialog(user);
    const checkboxes = within(dialog).getAllByRole("checkbox");
    // endpoints:write (ADR-0075) is now a grantable scope, so the create-key form renders it too. A key
    // carrying it can create endpoints via api/cli/mcp; the dashboard endpoint-create UI is still S1.
    expect(checkboxes).toHaveLength(5);
    for (const scope of [
      "endpoints:read",
      "endpoints:write",
      "events:read",
      "events:replay",
      "audit:read",
    ]) {
      expect(within(dialog).getByText(scope)).toBeInTheDocument();
    }
    expect(within(dialog).queryByText("keys:manage")).not.toBeInTheDocument();
  });

  it("renders exactly the scopes it is handed by the gated page", async () => {
    const user = userEvent.setup();
    render(
      <CredentialsManager
        initialResult={okResult}
        createKey={vi.fn()}
        scopes={["events:read", "audit:read"]}
      />,
    );
    const dialog = await openCreateDialog(user);
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(dialog).getByText("events:read")).toBeInTheDocument();
    expect(within(dialog).getByText("audit:read")).toBeInTheDocument();
    expect(within(dialog).queryByText("endpoints:read")).not.toBeInTheDocument();
  });

  it("calls createKey with the name and selected scopes", async () => {
    const user = userEvent.setup();
    const createKey = vi.fn(async () => createdKey("whsec_secretvalue1234"));
    render(
      <CredentialsManager
        initialResult={okResult}
        createKey={createKey}
        scopes={CAPABILITY_SCOPES}
      />,
    );
    const dialog = await openCreateDialog(user);
    await user.type(within(dialog).getByLabelText(/name/i), "CI deploy");
    await user.click(within(dialog).getByText("events:read"));
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));
    expect(createKey).toHaveBeenCalledWith({ name: "CI deploy", scopes: ["events:read"] });
  });

  it("reveals the plaintext exactly once, then redacts it on dismiss", async () => {
    const user = userEvent.setup();
    const secret = "whsec_onlyshownonce999";
    const createKey = vi.fn(async () => createdKey(secret));
    render(
      <CredentialsManager
        initialResult={okResult}
        createKey={createKey}
        scopes={CAPABILITY_SCOPES}
      />,
    );

    // the secret is never in the initial render
    expect(screen.queryByText(secret)).not.toBeInTheDocument();

    const dialog = await openCreateDialog(user);
    await user.type(within(dialog).getByLabelText(/name/i), "CI deploy");
    await user.click(within(dialog).getByText("events:read"));
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));

    // shown once, with a "won't see it again" warning
    expect(await screen.findByText(secret)).toBeInTheDocument();
    expect(screen.getByText(/only time/i)).toBeInTheDocument();

    // dismiss → the plaintext is gone; only the redacted prefix remains in the list
    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.getByText(`${secret.slice(0, 11)}…${secret.slice(-4)}`)).toBeInTheDocument();
  });

  it("disables create until a name and at least one scope are chosen", async () => {
    const user = userEvent.setup();
    render(
      <CredentialsManager
        initialResult={okResult}
        createKey={vi.fn()}
        scopes={CAPABILITY_SCOPES}
      />,
    );
    const dialog = await openCreateDialog(user);
    const submit = within(dialog).getByRole("button", { name: /^create$/i });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/name/i), "CI deploy");
    expect(submit).toBeDisabled(); // still no scope
    await user.click(within(dialog).getByText("events:read"));
    expect(submit).toBeEnabled();
  });

  it("falls back to the read-only view when access is denied", () => {
    render(
      <CredentialsManager
        initialResult={{ status: "denied" }}
        createKey={vi.fn()}
        scopes={CAPABILITY_SCOPES}
      />,
    );
    expect(screen.queryByRole("button", { name: /create key/i })).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });
});

const activeKey: ApiKeyItem = {
  id: "key_live",
  name: "Production signer",
  start: "whsec_9b3a…e21f",
  scopes: ["events:read"],
  createdAt: new Date("2026-04-12T00:00:00Z"),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

const revokedKey: ApiKeyItem = {
  ...activeKey,
  id: "key_dead",
  name: "Old key",
  revokedAt: new Date("2026-01-01T00:00:00Z"),
};

const childKey: ApiKeyItem = {
  ...activeKey,
  id: "key_child",
  name: "wbhk cli",
  start: "whk_2aF9…7c1d",
};

const activeGrant: DeviceGrant = {
  id: "grant_live",
  status: "active",
  authMethod: "device_code",
  deviceName: "Dana's MacBook",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  lastUsedAt: null,
  approvedAt: new Date("2026-05-01T00:00:00Z"),
  revokedAt: null,
  expiresAt: null,
  keys: [childKey],
};

const expiredGrant: DeviceGrant = {
  ...activeGrant,
  id: "grant_old",
  status: "expired",
  deviceName: "ci-runner",
  keys: [],
};

type RevokeFn = (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;

function renderRevocable(
  result: CredentialsResult,
  actions: { revokeKey?: RevokeFn; revokeGrant?: RevokeFn } = {},
) {
  const revokeKey = actions.revokeKey ?? vi.fn(async () => ({ ok: true as const }));
  const revokeGrant = actions.revokeGrant ?? vi.fn(async () => ({ ok: true as const }));
  render(
    <CredentialsManager
      initialResult={result}
      createKey={vi.fn()}
      revokeKey={revokeKey}
      revokeGrant={revokeGrant}
      scopes={CAPABILITY_SCOPES}
    />,
  );
  return { revokeKey, revokeGrant };
}

describe("CredentialsManager — revoke", () => {
  it("revokes a standalone key after confirmation", async () => {
    const user = userEvent.setup();
    const { revokeKey } = renderRevocable({ status: "ok", devices: [], keys: [activeKey] });

    await user.click(screen.getByRole("button", { name: `Revoke ${activeKey.name}` }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    expect(revokeKey).toHaveBeenCalledWith(activeKey.id);
    // the row now reads as dead and the revoke affordance is gone
    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Revoke ${activeKey.name}` }),
    ).not.toBeInTheDocument();
  });

  it("cascades a device-grant revoke to its child keys", async () => {
    const user = userEvent.setup();
    const { revokeGrant } = renderRevocable({ status: "ok", devices: [activeGrant], keys: [] });

    await user.click(screen.getByRole("button", { name: `Revoke ${activeGrant.deviceName}` }));
    const dialog = screen.getByRole("dialog");
    // the confirm spells out the cascade
    expect(within(dialog).getByText(/1 key/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Revoke device" }));

    expect(revokeGrant).toHaveBeenCalledWith(activeGrant.id);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // both the grant badge and its one child key now read revoked
    expect(screen.getAllByText("revoked")).toHaveLength(2);
  });

  it("offers no revoke affordance for already-dead credentials", () => {
    renderRevocable({ status: "ok", devices: [expiredGrant], keys: [revokedKey] });
    expect(
      screen.queryByRole("button", { name: `Revoke ${revokedKey.name}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Revoke ${expiredGrant.deviceName}` }),
    ).not.toBeInTheDocument();
  });

  it("leaves the credential intact when the confirm is cancelled", async () => {
    const user = userEvent.setup();
    const { revokeKey } = renderRevocable({ status: "ok", devices: [], keys: [activeKey] });

    await user.click(screen.getByRole("button", { name: `Revoke ${activeKey.name}` }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /cancel/i }));

    expect(revokeKey).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `Revoke ${activeKey.name}` })).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("surfaces an error and keeps the key active when the revoke fails", async () => {
    const user = userEvent.setup();
    const revokeKey = vi.fn(async () => ({
      ok: false as const,
      error: "Could not revoke the key.",
    }));
    renderRevocable({ status: "ok", devices: [], keys: [activeKey] }, { revokeKey });

    await user.click(screen.getByRole("button", { name: `Revoke ${activeKey.name}` }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    expect(await within(dialog).findByText("Could not revoke the key.")).toBeInTheDocument();
    // still revocable — the confirm stays open
    expect(within(dialog).getByRole("button", { name: "Revoke key" })).toBeInTheDocument();
  });

  it("cannot be dismissed while a revoke is in flight (no swallowed failure)", async () => {
    const user = userEvent.setup();
    let settle: (v: { ok: true }) => void = () => {};
    const revokeKey = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          settle = resolve;
        }),
    );
    renderRevocable({ status: "ok", devices: [], keys: [activeKey] }, { revokeKey });

    await user.click(screen.getByRole("button", { name: `Revoke ${activeKey.name}` }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke key" }),
    );

    // mid-flight Escape must NOT close the confirm — otherwise a later failure's error is swallowed
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => settle({ ok: true })); // let the in-flight action settle cleanly
  });
});
