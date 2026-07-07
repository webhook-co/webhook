import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriggerItem } from "@/server/agent-triggers";

import { AgentTriggersManager, type EndpointOption } from "./agent-triggers-manager";

// The manager imports the server actions directly; mock the module so the component under test drives our
// stubs. vi.hoisted lifts the mock fns above the hoisted vi.mock factory (the repo's vitest requires this).
const actions = vi.hoisted(() => ({
  createTriggerAction: vi.fn(),
  revokeTriggerAction: vi.fn(),
}));
vi.mock("@/server/agent-trigger-actions", () => actions);

const EP_A = "22222222-2222-4222-8222-222222222222";
const EP_B = "33333333-3333-4333-8333-333333333333";
const endpoints: EndpointOption[] = [
  { id: EP_A, name: "orders" },
  { id: EP_B, name: "payments" },
];

function trigger(over: Partial<TriggerItem> = {}): TriggerItem {
  return {
    id: "t1",
    endpointId: EP_A,
    name: "fraud-agent",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    revokedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentTriggersManager", () => {
  it("renders the empty state explaining what a trigger is when there are none", () => {
    render(<AgentTriggersManager initial={[]} endpoints={endpoints} />);
    expect(screen.getByText(/no triggers yet/i)).toBeInTheDocument();
    expect(screen.getByText(/woken when an endpoint captures a new event/i)).toBeInTheDocument();
  });

  it("lists an existing trigger with its endpoint NAME (not the raw id) and label", () => {
    render(<AgentTriggersManager initial={[trigger()]} endpoints={endpoints} />);
    expect(screen.getByText("fraud-agent")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.queryByText(EP_A)).not.toBeInTheDocument();
  });

  it("disables create and explains why when the org has no endpoints", () => {
    render(<AgentTriggersManager initial={[]} endpoints={[]} />);
    expect(screen.getByRole("button", { name: /create trigger/i })).toBeDisabled();
    expect(screen.getByText(/create an endpoint first/i)).toBeInTheDocument();
  });

  it("creates a trigger for the picked endpoint and prepends the row", async () => {
    const user = userEvent.setup();
    actions.createTriggerAction.mockResolvedValue({
      ok: true,
      trigger: trigger({ id: "t2", endpointId: EP_B, name: "risk-agent" }),
    });
    render(<AgentTriggersManager initial={[]} endpoints={endpoints} />);

    // Pick an endpoint via the searchable combobox (trigger button announces "Endpoint: …").
    await user.click(screen.getByRole("button", { name: /endpoint:/i }));
    await user.click(screen.getByRole("option", { name: "payments" }));
    await user.type(screen.getByLabelText(/label/i), "risk-agent");
    await user.click(screen.getByRole("button", { name: /create trigger/i }));

    expect(actions.createTriggerAction).toHaveBeenCalledWith({
      endpointId: EP_B,
      name: "risk-agent",
    });
    await waitFor(() => expect(screen.getByText("risk-agent")).toBeInTheDocument());
    expect(screen.getByText("payments")).toBeInTheDocument();
  });

  it("surfaces the returned error inline and adds no row when create fails", async () => {
    const user = userEvent.setup();
    actions.createTriggerAction.mockResolvedValue({
      ok: false,
      error: "You've reached the active-trigger limit. Revoke an unused trigger and try again.",
    });
    render(<AgentTriggersManager initial={[]} endpoints={endpoints} />);

    await user.click(screen.getByRole("button", { name: /endpoint:/i }));
    await user.click(screen.getByRole("option", { name: "orders" }));
    await user.click(screen.getByRole("button", { name: /create trigger/i }));

    await waitFor(() => expect(screen.getByText(/active-trigger limit/i)).toBeInTheDocument());
    expect(screen.getByText(/no triggers yet/i)).toBeInTheDocument();
  });

  it("revokes a trigger through the confirm dialog and drops the row", async () => {
    const user = userEvent.setup();
    actions.revokeTriggerAction.mockResolvedValue({ ok: true });
    render(<AgentTriggersManager initial={[trigger()]} endpoints={endpoints} />);

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    // Confirm dialog appears; confirm the destructive action.
    await user.click(screen.getByRole("button", { name: /revoke trigger/i }));

    expect(actions.revokeTriggerAction).toHaveBeenCalledWith("t1");
    await waitFor(() => expect(screen.queryByText("fraud-agent")).not.toBeInTheDocument());
    expect(screen.getByText(/no triggers yet/i)).toBeInTheDocument();
  });

  it("keeps the row and shows the failure inside the dialog when revoke fails", async () => {
    const user = userEvent.setup();
    actions.revokeTriggerAction.mockResolvedValue({
      ok: false,
      error: "That trigger no longer exists.",
    });
    render(<AgentTriggersManager initial={[trigger()]} endpoints={endpoints} />);

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    await user.click(screen.getByRole("button", { name: /revoke trigger/i }));

    await waitFor(() =>
      expect(screen.getByText(/that trigger no longer exists/i)).toBeInTheDocument(),
    );
    // The row is still present (dialog stays open on failure).
    expect(screen.getByText("fraud-agent")).toBeInTheDocument();
  });
});
