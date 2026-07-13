import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DestinationKeysDialog } from "./destination-keys-dialog";

// The dialog imports the action directly; mock the module so we drive the load. vi.hoisted lifts the mock fn
// above the hoisted vi.mock factory (the repo's vitest requires this).
const actions = vi.hoisted(() => ({
  listDestinationSecretsAction: vi.fn(),
}));

vi.mock("@/server/replay-destination-actions", () => actions);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DestinationKeysDialog", () => {
  it("loads on open and renders the returned key metadata (status + date), no secret", async () => {
    actions.listDestinationSecretsAction.mockResolvedValue({
      ok: true,
      items: [
        { id: "k1", status: "active", createdAt: new Date("2026-07-01T00:00:00Z") },
        { id: "k2", status: "retiring", createdAt: new Date("2026-06-01T00:00:00Z") },
      ],
    });
    render(<DestinationKeysDialog slug="acme" open destinationId="d1" onClose={vi.fn()} />);

    expect(actions.listDestinationSecretsAction).toHaveBeenCalledWith("acme", "d1");
    await waitFor(() => expect(screen.getByText("active")).toBeInTheDocument());
    expect(screen.getByText("retiring")).toBeInTheDocument();
    // Metadata only — the dialog never shows a secret.
    expect(screen.queryByText(/whsec_/)).not.toBeInTheDocument();
  });

  it("renders an empty state when there are no signing keys", async () => {
    actions.listDestinationSecretsAction.mockResolvedValue({ ok: true, items: [] });
    render(<DestinationKeysDialog slug="acme" open destinationId="d1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no signing keys yet/i)).toBeInTheDocument());
  });

  it("shows the error state when the load fails", async () => {
    actions.listDestinationSecretsAction.mockResolvedValue({
      ok: false,
      error: "We couldn't load the signing keys.",
    });
    render(<DestinationKeysDialog slug="acme" open destinationId="d1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/couldn't load the signing keys/i)).toBeInTheDocument(),
    );
  });

  it("does not load while closed", () => {
    render(<DestinationKeysDialog slug="acme" open={false} destinationId="d1" onClose={vi.fn()} />);
    expect(actions.listDestinationSecretsAction).not.toHaveBeenCalled();
  });
});
