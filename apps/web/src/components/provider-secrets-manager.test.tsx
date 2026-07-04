import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderSecretItem } from "@/server/provider-secrets";

import { ProviderSecretsManager } from "./provider-secrets-manager";

const ENDPOINT = "11111111-1111-1111-1111-111111111111";

function item(over: Partial<ProviderSecretItem> = {}): ProviderSecretItem {
  return {
    id: "s1",
    provider: "stripe",
    status: "active",
    label: "Production",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  };
}

let add: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  add = vi.fn();
  revoke = vi.fn();
});

function renderManager(initial: ProviderSecretItem[] = []) {
  return render(
    <ProviderSecretsManager endpointId={ENDPOINT} initial={initial} add={add} revoke={revoke} />,
  );
}

describe("ProviderSecretsManager — add", () => {
  it("prepends a metadata row on success and shows NO secret value", async () => {
    const user = userEvent.setup();
    add.mockResolvedValue({ ok: true, secret: { id: "s2", provider: "stripe", status: "active" } });
    renderManager([]);

    await user.type(screen.getByLabelText(/^secret$/i), "whsec_topsecret");
    await user.click(screen.getByRole("button", { name: /add secret/i }));

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: ENDPOINT, provider: "stripe", kind: "signing_secret" }),
    );
    // A metadata row is present (scoped to the table — "Stripe" also appears as a select option); the
    // secret value is never rendered anywhere.
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(within(screen.getByRole("table")).getByText("Stripe")).toBeInTheDocument();
    expect(screen.queryByText(/whsec_topsecret/)).not.toBeInTheDocument();
  });

  it("renders a VALIDATION error inline and adds no row", async () => {
    const user = userEvent.setup();
    add.mockResolvedValue({
      ok: false,
      error: "a Standard Webhooks secret must be base64 key material",
    });
    renderManager([]);

    await user.type(screen.getByLabelText(/^secret$/i), "not-base64");
    await user.click(screen.getByRole("button", { name: /add secret/i }));

    await waitFor(() => expect(screen.getByText(/base64 key material/i)).toBeInTheDocument());
    expect(screen.getByText(/no provider secrets yet/i)).toBeInTheDocument();
  });

  it("clears a prior form error as soon as the operator edits an input", async () => {
    const user = userEvent.setup();
    add.mockResolvedValue({ ok: false, error: "Keep the label under 200 characters." });
    renderManager([]);

    await user.type(screen.getByLabelText(/^secret$/i), "whsec_x");
    await user.click(screen.getByRole("button", { name: /add secret/i }));
    await waitFor(() => expect(screen.getByText(/keep the label under 200/i)).toBeInTheDocument());

    // Editing any field is a correction-in-progress — the stale error must not linger.
    await user.type(screen.getByLabelText(/label/i), "prod");
    expect(screen.queryByText(/keep the label under 200/i)).not.toBeInTheDocument();
  });

  it("shows an added row's time as 'Just now' until the server row reconciles", async () => {
    const user = userEvent.setup();
    add.mockResolvedValue({ ok: true, secret: { id: "s2", provider: "stripe", status: "active" } });
    renderManager([]);

    await user.type(screen.getByLabelText(/^secret$/i), "whsec_topsecret");
    await user.click(screen.getByRole("button", { name: /add secret/i }));

    // The optimistic row must not fabricate a browser-clock timestamp — it reads "Just now".
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText(/just now/i)).toBeInTheDocument(),
    );
  });

  it("masks the secret input (type=password)", () => {
    renderManager([]);
    expect(screen.getByLabelText(/^secret$/i)).toHaveAttribute("type", "password");
  });
});

describe("ProviderSecretsManager — kind options depend on provider", () => {
  it("offers only signing_secret for a plain provider, and verify_token for a verify-token provider", async () => {
    const user = userEvent.setup();
    renderManager([]);

    const kindSelect = screen.getByLabelText(/secret type/i);
    // Stripe (default) → signing_secret only.
    expect(within(kindSelect).queryByRole("option", { name: /verify token/i })).toBeNull();

    // Switch the provider to Meta (a verify-token provider) → the Verify token option appears.
    await user.selectOptions(screen.getByLabelText(/provider/i), "meta");
    await waitFor(() =>
      expect(within(kindSelect).getByRole("option", { name: /verify token/i })).toBeInTheDocument(),
    );
  });
});

describe("ProviderSecretsManager — revoke", () => {
  it("confirms a revoke and marks the row revoked", async () => {
    const user = userEvent.setup();
    revoke.mockResolvedValue({ ok: true });
    renderManager([item()]);

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/stop verifying immediately/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /revoke secret/i }));

    expect(revoke).toHaveBeenCalledWith(ENDPOINT, "s1");
    // The row is marked revoked in place (history retained) — the Revoke button is gone.
    await waitFor(() => expect(screen.getByText("revoked")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^revoke$/i })).not.toBeInTheDocument();
  });

  it("reconciles the row to revoked when the secret is already gone", async () => {
    const user = userEvent.setup();
    // A NOT_FOUND revoke (already revoked elsewhere / unknown) comes back `gone` — the UI must settle the row
    // to revoked exactly as a success would, not strand a live-looking row behind an error.
    revoke.mockResolvedValue({ ok: false, error: "That secret no longer exists.", gone: true });
    renderManager([item()]);

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /revoke secret/i }));

    await waitFor(() => expect(screen.getByText("revoked")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument();
  });

  it("fires the revoke action only once on a double-click", async () => {
    const user = userEvent.setup();
    let resolve: (() => void) | undefined;
    revoke.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = () => r({ ok: true });
        }),
    );
    renderManager([item()]);

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = screen.getByRole("dialog");
    await user.dblClick(within(dialog).getByRole("button", { name: /revoke secret/i }));
    expect(revoke).toHaveBeenCalledTimes(1);

    resolve?.();
    await waitFor(() => expect(screen.getByText("revoked")).toBeInTheDocument());
  });
});
