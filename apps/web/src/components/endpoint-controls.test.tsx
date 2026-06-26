import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EndpointItem } from "@/server/endpoints";

import { EndpointControls } from "./endpoint-controls";

const ep: EndpointItem = {
  id: "ep_1",
  name: "Stripe prod",
  paused: false,
  createdAt: new Date("2026-06-25T00:00:00Z"),
};

describe("EndpointControls (menu variant)", () => {
  it("rotates from the ⋯ menu and reveals the new one-time URL", async () => {
    const user = userEvent.setup();
    const rotateEndpoint = vi.fn(async () => ({
      ok: true as const,
      ingestUrl: "https://wbhk.my/whep_rotated",
    }));
    render(
      <EndpointControls
        endpoint={ep}
        variant="menu"
        rotateEndpoint={rotateEndpoint}
        deleteEndpoint={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Stripe prod" }));
    await user.click(screen.getByRole("menuitem", { name: /rotate url/i }));
    const dialog = screen.getByRole("dialog");
    // The hard-cut warning names the endpoint so a per-row rotate is unambiguous.
    expect(within(dialog).getByText(/stops working the moment you rotate/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /rotate url/i }));

    expect(rotateEndpoint).toHaveBeenCalledWith("ep_1");
    await waitFor(() =>
      expect(screen.getByText(/only time you'll see this url/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("https://wbhk.my/whep_rotated")).toBeInTheDocument();
  });

  it("deletes from the ⋯ menu and calls onDeleted (the list removes the row)", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    const deleteEndpoint = vi.fn(async () => ({ ok: true as const }));
    render(
      <EndpointControls
        endpoint={ep}
        variant="menu"
        rotateEndpoint={vi.fn()}
        deleteEndpoint={deleteEndpoint}
        onDeleted={onDeleted}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Stripe prod" }));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/stops receiving webhooks immediately/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /delete endpoint/i }));

    expect(deleteEndpoint).toHaveBeenCalledWith("ep_1");
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });

  it("keeps the row (onDeleted not called) and shows the error when the delete fails", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    const deleteEndpoint = vi.fn(async () => ({ ok: false as const, error: "endpoint not found" }));
    render(
      <EndpointControls
        endpoint={ep}
        variant="menu"
        rotateEndpoint={vi.fn()}
        deleteEndpoint={deleteEndpoint}
        onDeleted={onDeleted}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Stripe prod" }));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /delete endpoint/i }));

    await waitFor(() => expect(screen.getByText(/endpoint not found/i)).toBeInTheDocument());
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("EndpointControls (buttons variant)", () => {
  it("renders explicit Rotate/Delete buttons (no ⋯ menu)", () => {
    render(
      <EndpointControls
        endpoint={ep}
        variant="buttons"
        rotateEndpoint={vi.fn()}
        deleteEndpoint={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /rotate url/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete endpoint/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Actions for Stripe prod" }),
    ).not.toBeInTheDocument();
  });
});
