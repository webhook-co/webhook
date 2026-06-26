import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EndpointItem } from "@/server/endpoints";

import { EndpointDetail } from "./endpoint-detail";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const ep: EndpointItem = {
  id: "ep_1",
  name: "Stripe prod",
  paused: false,
  createdAt: new Date("2026-06-25T00:00:00Z"),
};

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
});

describe("EndpointDetail", () => {
  it("renders the endpoint config (name, id, status)", () => {
    render(<EndpointDetail endpoint={ep} rotateEndpoint={vi.fn()} deleteEndpoint={vi.fn()} />);
    expect(screen.getByText("Stripe prod")).toBeInTheDocument();
    expect(screen.getByText("ep_1")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("warns about the hard cutover, then rotates and reveals the new one-time URL", async () => {
    const user = userEvent.setup();
    const rotateEndpoint = vi.fn(async () => ({
      ok: true as const,
      ingestUrl: "https://wbhk.my/whep_rotated",
    }));
    render(
      <EndpointDetail endpoint={ep} rotateEndpoint={rotateEndpoint} deleteEndpoint={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: /rotate url/i }));
    const dialog = screen.getByRole("dialog");
    // The truthful hard-cut warning (no grace window).
    expect(within(dialog).getByText(/stops working the moment you rotate/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /rotate url/i }));

    expect(rotateEndpoint).toHaveBeenCalledWith("ep_1");
    await waitFor(() =>
      expect(screen.getByText(/only time you'll see this url/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("https://wbhk.my/whep_rotated")).toBeInTheDocument();
  });

  it("warns soft-delete is immediate but events are retained, then deletes and navigates away", async () => {
    const user = userEvent.setup();
    const deleteEndpoint = vi.fn(async () => ({ ok: true as const }));
    render(
      <EndpointDetail endpoint={ep} rotateEndpoint={vi.fn()} deleteEndpoint={deleteEndpoint} />,
    );

    await user.click(screen.getByRole("button", { name: /delete endpoint/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/stops receiving webhooks immediately/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/past events stay inspectable/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /delete endpoint/i }));

    expect(deleteEndpoint).toHaveBeenCalledWith("ep_1");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/endpoints"));
  });

  it("surfaces a rotate error in the confirm dialog without revealing a URL", async () => {
    const user = userEvent.setup();
    const rotateEndpoint = vi.fn(async () => ({ ok: false as const, error: "endpoint not found" }));
    render(
      <EndpointDetail endpoint={ep} rotateEndpoint={rotateEndpoint} deleteEndpoint={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: /rotate url/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /rotate url/i }));

    await waitFor(() => expect(screen.getByText(/endpoint not found/i)).toBeInTheDocument());
    expect(screen.queryByText(/only time you'll see this url/i)).not.toBeInTheDocument();
  });
});
