import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DestinationItem } from "@/server/replay-destinations";

import { ReplayDestinationsManager } from "./replay-destinations-manager";

// The manager imports the server actions directly; mock the module so the component under test drives our
// stubs. vi.hoisted lifts the mock fns above the hoisted vi.mock factory (the repo's vitest requires this).
const actions = vi.hoisted(() => ({
  createDestinationAction: vi.fn(),
  deleteDestinationAction: vi.fn(),
  enableDestinationAction: vi.fn(),
  rotateDestinationSecretAction: vi.fn(),
  setDestinationOrderedAction: vi.fn(),
  listDestinationSecretsAction: vi.fn(),
}));

vi.mock("@/server/replay-destination-actions", () => actions);

function dest(over: Partial<DestinationItem> = {}): DestinationItem {
  return {
    id: "d1",
    url: "https://api.example.com/hook",
    label: "Orders",
    status: "active",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastValidatedAt: null,
    ordered: false,
    disabledAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReplayDestinationsManager", () => {
  it("renders the empty state explaining what a destination is when there are none", () => {
    render(<ReplayDestinationsManager initial={[]} />);
    expect(screen.getByText(/no destinations yet/i)).toBeInTheDocument();
    expect(screen.getByText(/register a public https url/i)).toBeInTheDocument();
  });

  it("creates a destination, prepends the row, and reveals the one-time signing secret", async () => {
    const user = userEvent.setup();
    actions.createDestinationAction.mockResolvedValue({
      ok: true,
      destination: dest({ id: "d2", url: "https://new.example.com/hook", label: null }),
      signingSecret: "whsec_fresh",
    });
    render(<ReplayDestinationsManager initial={[]} />);

    await user.type(screen.getByLabelText(/destination url/i), "https://new.example.com/hook");
    await user.click(screen.getByRole("button", { name: /add destination/i }));

    expect(actions.createDestinationAction).toHaveBeenCalledWith({
      url: "https://new.example.com/hook",
      label: undefined,
    });
    await waitFor(() => expect(screen.getByText("whsec_fresh")).toBeInTheDocument());
    expect(screen.getByText(/only time you'll see this signing secret/i)).toBeInTheDocument();
    // The new row is present optimistically.
    expect(screen.getByText("https://new.example.com/hook")).toBeInTheDocument();
  });

  it("surfaces the returned error inline and adds no row when create fails", async () => {
    const user = userEvent.setup();
    actions.createDestinationAction.mockResolvedValue({
      ok: false,
      error: "Enter a public hostname, not an IP address.",
    });
    render(<ReplayDestinationsManager initial={[]} />);

    await user.type(screen.getByLabelText(/destination url/i), "https://10.0.0.1/hook");
    await user.click(screen.getByRole("button", { name: /add destination/i }));

    await waitFor(() => expect(screen.getByText(/enter a public hostname/i)).toBeInTheDocument());
    // No secret revealed, and the list is still empty.
    expect(screen.queryByText(/only time you'll see this signing secret/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no destinations yet/i)).toBeInTheDocument();
  });

  it("shows an 'already registered' note and no reveal on an idempotent re-add", async () => {
    const user = userEvent.setup();
    actions.createDestinationAction.mockResolvedValue({ ok: true, destination: dest() });
    render(<ReplayDestinationsManager initial={[]} />);

    await user.type(screen.getByLabelText(/destination url/i), "https://api.example.com/hook");
    await user.click(screen.getByRole("button", { name: /add destination/i }));

    await waitFor(() => expect(screen.getByText(/already registered/i)).toBeInTheDocument());
    expect(screen.queryByText(/only time you'll see this signing secret/i)).not.toBeInTheDocument();
  });

  it("rotates a destination's secret and reveals the new one-time secret", async () => {
    const user = userEvent.setup();
    actions.rotateDestinationSecretAction.mockResolvedValue({
      ok: true,
      signingSecret: "whsec_rotated",
    });
    render(<ReplayDestinationsManager initial={[dest()]} />);

    await user.click(screen.getByRole("button", { name: /rotate secret/i }));

    expect(actions.rotateDestinationSecretAction).toHaveBeenCalledWith("d1");
    await waitFor(() => expect(screen.getByText("whsec_rotated")).toBeInTheDocument());
  });

  it("confirms a remove and drops the row optimistically", async () => {
    const user = userEvent.setup();
    actions.deleteDestinationAction.mockResolvedValue({ ok: true });
    render(<ReplayDestinationsManager initial={[dest()]} />);

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/replays and deliveries can no longer target it/i),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /remove destination/i }));

    expect(actions.deleteDestinationAction).toHaveBeenCalledWith("d1");
    await waitFor(() =>
      expect(screen.queryByText("https://api.example.com/hook")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/no destinations yet/i)).toBeInTheDocument();
  });

  it("hides Enable on an active row", () => {
    render(<ReplayDestinationsManager initial={[dest()]} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^enable$/i })).not.toBeInTheDocument();
  });

  it("shows Enable only for a disabled row and replaces it with the enabled record", async () => {
    const user = userEvent.setup();
    actions.enableDestinationAction.mockResolvedValue({
      ok: true,
      destination: dest({ disabledAt: null }),
    });
    render(
      <ReplayDestinationsManager
        initial={[dest({ disabledAt: new Date("2026-07-02T00:00:00Z") })]}
      />,
    );

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^enable$/i }));

    expect(actions.enableDestinationAction).toHaveBeenCalledWith("d1");
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    // Once enabled, the Enable affordance is gone.
    expect(screen.queryByRole("button", { name: /^enable$/i })).not.toBeInTheDocument();
  });

  it("toggles ordered via the action and reverts on failure", async () => {
    const user = userEvent.setup();
    actions.setDestinationOrderedAction.mockResolvedValue({
      ok: false,
      error: "We couldn't update the destination. Please try again.",
    });
    render(<ReplayDestinationsManager initial={[dest({ ordered: false })]} />);

    const toggle = screen.getByRole("checkbox", { name: /strict ordering/i });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(actions.setDestinationOrderedAction).toHaveBeenCalledWith("d1", true);
    await waitFor(() =>
      expect(screen.getByText(/couldn't update the destination/i)).toBeInTheDocument(),
    );
    // The optimistic flip is reverted on failure.
    expect(toggle).not.toBeChecked();
  });

  it("fires a mutating action only once on a double-click", async () => {
    const user = userEvent.setup();
    let resolve: (() => void) | undefined;
    actions.rotateDestinationSecretAction.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = () => r({ ok: true, signingSecret: "whsec_once" });
        }),
    );
    render(<ReplayDestinationsManager initial={[dest()]} />);

    await user.dblClick(screen.getByRole("button", { name: /rotate secret/i }));
    expect(actions.rotateDestinationSecretAction).toHaveBeenCalledTimes(1);

    resolve?.();
    await waitFor(() => expect(screen.getByText("whsec_once")).toBeInTheDocument());
  });

  it("reconciles a new `initial` array in place (out-of-band auto-disable) without a remount", () => {
    const { rerender } = render(<ReplayDestinationsManager initial={[dest()]} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^enable$/i })).not.toBeInTheDocument();

    // The server now reports the row as auto-disabled; a fresh `initial` must surface it on re-render.
    rerender(
      <ReplayDestinationsManager
        initial={[dest({ disabledAt: new Date("2026-07-03T00:00:00Z") })]}
      />,
    );
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^enable$/i })).toBeInTheDocument();
  });

  it("serializes row ops: while one is pending, the other controls on that row are disabled", async () => {
    const user = userEvent.setup();
    // A rotate that never resolves keeps the row's guard held.
    actions.rotateDestinationSecretAction.mockImplementation(() => new Promise(() => {}));
    render(
      <ReplayDestinationsManager
        initial={[dest({ disabledAt: new Date("2026-07-02T00:00:00Z") })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rotate secret/i }));

    // Every other mutating control on the same row is now disabled (single in-flight op per destination).
    await waitFor(() => expect(screen.getByRole("button", { name: /^remove$/i })).toBeDisabled());
    expect(screen.getByRole("button", { name: /^enable$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^keys$/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /strict ordering/i })).toBeDisabled();
  });

  it("keeps the remove dialog open and shows the failure inside it", async () => {
    const user = userEvent.setup();
    actions.deleteDestinationAction.mockResolvedValue({
      ok: false,
      error: "We couldn't remove the destination. Please try again.",
    });
    render(<ReplayDestinationsManager initial={[dest()]} />);

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /remove destination/i }));

    // The error renders INSIDE the still-open modal, and the row survives.
    await waitFor(() =>
      expect(within(dialog).getByText(/couldn't remove the destination/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("https://api.example.com/hook")).toBeInTheDocument();
  });

  it("clears the stale 'already registered' note when a later row action runs", async () => {
    const user = userEvent.setup();
    actions.createDestinationAction.mockResolvedValue({ ok: true, destination: dest() });
    actions.rotateDestinationSecretAction.mockResolvedValue({
      ok: true,
      signingSecret: "whsec_rotated",
    });
    render(<ReplayDestinationsManager initial={[dest()]} />);

    // Trigger the idempotent-re-add note.
    await user.type(screen.getByLabelText(/destination url/i), "https://api.example.com/hook");
    await user.click(screen.getByRole("button", { name: /add destination/i }));
    await waitFor(() => expect(screen.getByText(/already registered/i)).toBeInTheDocument());

    // A later, unrelated row action must clear the lingering note.
    await user.click(screen.getByRole("button", { name: /rotate secret/i }));
    await waitFor(() => expect(screen.getByText("whsec_rotated")).toBeInTheDocument());
    expect(screen.queryByText(/already registered/i)).not.toBeInTheDocument();
  });

  it("opens the Keys dialog and loads the destination's signing-key history", async () => {
    const user = userEvent.setup();
    actions.listDestinationSecretsAction.mockResolvedValue({
      ok: true,
      items: [{ id: "k1", status: "active", createdAt: new Date("2026-07-01T00:00:00Z") }],
    });
    render(<ReplayDestinationsManager initial={[dest()]} />);

    await user.click(screen.getByRole("button", { name: /^keys$/i }));

    expect(actions.listDestinationSecretsAction).toHaveBeenCalledWith("d1");
    // The loaded key metadata renders inside the dialog.
    await waitFor(() => expect(screen.getByText("active")).toBeInTheDocument());
  });
});
