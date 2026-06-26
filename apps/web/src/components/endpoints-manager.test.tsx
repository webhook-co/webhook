import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CreateEndpointResult } from "@/server/endpoint-actions";
import type { EndpointItem, EndpointsResult } from "@/server/endpoints";

import { EndpointsManager } from "./endpoints-manager";

const ep: EndpointItem = {
  id: "ep_1",
  name: "Stripe prod",
  paused: false,
  createdAt: new Date("2026-06-25T00:00:00Z"),
};

const created: CreateEndpointResult = {
  ok: true,
  endpoint: { id: "ep_new", name: "GitHub", paused: false, createdAt: new Date() },
  ingestUrl: "https://wbhk.my/whep_secret123",
};

// The rotate/delete actions are exercised in endpoint-controls.test.tsx; default them to no-ops for the
// list-level tests that don't drive a per-row action.
const noopActions = {
  rotateEndpoint: vi.fn(),
  deleteEndpoint: vi.fn(),
};

describe("EndpointsManager", () => {
  it("renders a create affordance and the empty state when there are no endpoints", () => {
    render(
      <EndpointsManager
        initialResult={{ status: "ok", endpoints: [] }}
        createEndpoint={vi.fn()}
        {...noopActions}
      />,
    );
    expect(screen.getByRole("button", { name: /create endpoint/i })).toBeInTheDocument();
    expect(screen.getByText(/no endpoints yet/i)).toBeInTheDocument();
  });

  it("lists the org's endpoints with a status, a detail link, and a per-row actions menu", () => {
    render(
      <EndpointsManager
        initialResult={{ status: "ok", endpoints: [ep] }}
        createEndpoint={vi.fn()}
        {...noopActions}
      />,
    );
    const link = screen.getByRole("link", { name: "Stripe prod" });
    expect(link).toHaveAttribute("href", "/endpoints/ep_1");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Stripe prod" })).toBeInTheDocument();
  });

  it("shows the error state when the load failed", () => {
    const result: EndpointsResult = { status: "error" };
    render(<EndpointsManager initialResult={result} createEndpoint={vi.fn()} {...noopActions} />);
    expect(screen.getByText(/couldn't load your endpoints/i)).toBeInTheDocument();
  });

  it("creates an endpoint and reveals the one-time ingest URL exactly once", async () => {
    const user = userEvent.setup();
    const createEndpoint = vi.fn(async () => created);
    render(
      <EndpointsManager
        initialResult={{ status: "ok", endpoints: [] }}
        createEndpoint={createEndpoint}
        {...noopActions}
      />,
    );

    await user.click(screen.getByRole("button", { name: /create endpoint/i }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/endpoint name/i), "GitHub");
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));

    expect(createEndpoint).toHaveBeenCalledWith({ name: "GitHub" });
    // The reveal dialog shows the full ingest URL + the one-time warning.
    await waitFor(() =>
      expect(screen.getByText(/only time you'll see this url/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("https://wbhk.my/whep_secret123")).toBeInTheDocument();
  });

  it("surfaces the action error in the form without revealing a URL", async () => {
    const user = userEvent.setup();
    const createEndpoint = vi.fn(async () => ({
      ok: false as const,
      error: "endpoint limit reached",
    }));
    render(
      <EndpointsManager
        initialResult={{ status: "ok", endpoints: [] }}
        createEndpoint={createEndpoint}
        {...noopActions}
      />,
    );

    await user.click(screen.getByRole("button", { name: /create endpoint/i }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/endpoint name/i), "x");
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText(/endpoint limit reached/i)).toBeInTheDocument());
    expect(screen.queryByText(/only time you'll see this url/i)).not.toBeInTheDocument();
  });

  it("removes a row in place when its ⋯ menu delete succeeds (no reload)", async () => {
    const user = userEvent.setup();
    const deleteEndpoint = vi.fn(async () => ({ ok: true as const }));
    render(
      <EndpointsManager
        initialResult={{ status: "ok", endpoints: [ep] }}
        createEndpoint={vi.fn()}
        rotateEndpoint={vi.fn()}
        deleteEndpoint={deleteEndpoint}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Stripe prod" }));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /delete endpoint/i }));

    expect(deleteEndpoint).toHaveBeenCalledWith("ep_1");
    // The row is dropped optimistically and the empty state takes its place — no page reload needed.
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Stripe prod" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/no endpoints yet/i)).toBeInTheDocument();
  });
});
