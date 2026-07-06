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
  dedupConfig: null,
};

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
});

const URL = "https://wbhk.my/whep_shown";

describe("EndpointDetail", () => {
  it("renders the endpoint config (name, id, status)", () => {
    render(
      <EndpointDetail
        endpoint={ep}
        ingestUrl={URL}
        rotateEndpoint={vi.fn()}
        deleteEndpoint={vi.fn()}
      />,
    );
    expect(screen.getByText("Stripe prod")).toBeInTheDocument();
    expect(screen.getByText("ep_1")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("ALWAYS shows the ingest URL with a copy affordance (decision-0018 / ADR-0101)", () => {
    render(
      <EndpointDetail
        endpoint={ep}
        ingestUrl={URL}
        rotateEndpoint={vi.fn()}
        deleteEndpoint={vi.fn()}
      />,
    );
    expect(screen.getByText(URL)).toBeInTheDocument();
    // No "shown only once" copy anymore — the URL is retrievable any time.
    expect(screen.queryByText(/shown only once/i)).not.toBeInTheDocument();
  });

  it("vertically centers each label with its value (the tall Copy button must not offset the labels)", () => {
    // Regression guard: the rows are a two-column grid whose height is set by the Copy button; without
    // `items-center` the label text sat ~7px above its centered value. jsdom has no layout, so this
    // asserts the load-bearing class rather than pixel positions.
    const { container } = render(
      <EndpointDetail
        endpoint={ep}
        ingestUrl={URL}
        rotateEndpoint={vi.fn()}
        deleteEndpoint={vi.fn()}
      />,
    );
    expect(container.querySelector("dl")).toHaveClass("items-center");
  });

  it("shows a rotate-to-reveal hint for a legacy endpoint with no recoverable URL (null)", () => {
    render(
      <EndpointDetail
        endpoint={ep}
        ingestUrl={null}
        rotateEndpoint={vi.fn()}
        deleteEndpoint={vi.fn()}
      />,
    );
    expect(screen.getByText(/rotate to mint a fresh ingest url/i)).toBeInTheDocument();
  });

  it("warns about the hard cutover, then rotates and reveals the new ingest URL", async () => {
    const user = userEvent.setup();
    const rotateEndpoint = vi.fn(async () => ({
      ok: true as const,
      ingestUrl: "https://wbhk.my/whep_rotated",
    }));
    render(
      <EndpointDetail
        endpoint={ep}
        ingestUrl={URL}
        rotateEndpoint={rotateEndpoint}
        deleteEndpoint={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rotate url/i }));
    const dialog = screen.getByRole("dialog");
    // The truthful hard-cut warning (no grace window).
    expect(within(dialog).getByText(/stops working the moment you rotate/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /rotate url/i }));

    expect(rotateEndpoint).toHaveBeenCalledWith("ep_1");
    await waitFor(() =>
      expect(screen.getByText("https://wbhk.my/whep_rotated")).toBeInTheDocument(),
    );

    // Dismissing the reveal dialog refreshes the page so the ALWAYS-SHOWN URL re-reveals the new token.
    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("warns soft-delete is immediate but events are retained, then deletes and navigates away", async () => {
    const user = userEvent.setup();
    const deleteEndpoint = vi.fn(async () => ({ ok: true as const }));
    render(
      <EndpointDetail
        endpoint={ep}
        ingestUrl={URL}
        rotateEndpoint={vi.fn()}
        deleteEndpoint={deleteEndpoint}
      />,
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
      <EndpointDetail
        endpoint={ep}
        ingestUrl={URL}
        rotateEndpoint={rotateEndpoint}
        deleteEndpoint={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rotate url/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /rotate url/i }));

    await waitFor(() => expect(screen.getByText(/endpoint not found/i)).toBeInTheDocument());
    expect(screen.queryByText("Copy your new webhook URL")).not.toBeInTheDocument();
  });
});
