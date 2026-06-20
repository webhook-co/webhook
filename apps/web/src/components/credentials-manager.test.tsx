import { CAPABILITY_SCOPES } from "@webhook-co/contract/capability";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CreateKeyResult } from "@/server/credential-actions";
import type { CredentialsResult } from "@/server/credentials";

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

  it("offers exactly the four grantable scopes — never the reserved keys:manage", async () => {
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
    expect(checkboxes).toHaveLength(4);
    for (const scope of ["endpoints:read", "events:read", "events:replay", "audit:read"]) {
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
