import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PayloadResult } from "@/server/payloads";

import { PayloadViewer } from "./payload-viewer";

const ENDPOINT_ID = "ep-1";
const EVENT_ID = "ev-1";
const DOWNLOAD_HREF = `/endpoints/${ENDPOINT_ID}/events/${EVENT_ID}/payload`;

function renderViewer(opts: {
  payloadBytes: number;
  contentType: string | null;
  result?: PayloadResult;
}) {
  const loadPayload = vi.fn(async () => opts.result ?? ({ kind: "error" } as PayloadResult));
  const utils = render(
    <PayloadViewer
      endpointId={ENDPOINT_ID}
      eventId={EVENT_ID}
      payloadBytes={opts.payloadBytes}
      contentType={opts.contentType}
      loadPayload={loadPayload}
      downloadHref={DOWNLOAD_HREF}
    />,
  );
  return { ...utils, loadPayload };
}

describe("PayloadViewer", () => {
  it("fetches a small text body and shows RAW by default, with a Pretty toggle", async () => {
    const user = userEvent.setup();
    const { container, loadPayload } = renderViewer({
      payloadBytes: 7,
      contentType: "application/json",
      result: { kind: "text", text: '{"a":1}', bytes: 7, contentType: "application/json" },
    });
    expect(loadPayload).toHaveBeenCalledWith({ endpointId: ENDPOINT_ID, eventId: EVENT_ID });

    // RAW (exact bytes) by default — the honest view
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe('{"a":1}'));
    // opt into Pretty → formatted
    await user.click(screen.getByRole("button", { name: /^pretty$/i }));
    expect(container.querySelector("pre")?.textContent).toContain('"a": 1');
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", DOWNLOAD_HREF);
  });

  it("renders a non-JSON text body raw with no pretty toggle", async () => {
    const { container } = renderViewer({
      payloadBytes: 15,
      contentType: "text/plain",
      result: { kind: "text", text: "plain text body", bytes: 15, contentType: "text/plain" },
    });
    await waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe("plain text body"),
    );
    expect(screen.queryByRole("button", { name: /pretty/i })).not.toBeInTheDocument();
  });

  it("gates too_large CLIENT-SIDE (no server round-trip)", async () => {
    const { loadPayload } = renderViewer({
      payloadBytes: 5_000_000,
      contentType: "application/json",
    });
    await waitFor(() => expect(screen.getByText(/too large to preview/i)).toBeInTheDocument());
    expect(loadPayload).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", DOWNLOAD_HREF);
  });

  it("gates a known-binary content type CLIENT-SIDE (no server round-trip)", async () => {
    const { loadPayload } = renderViewer({ payloadBytes: 2048, contentType: "image/png" });
    await waitFor(() => expect(screen.getByText(/binary payload/i)).toBeInTheDocument());
    expect(loadPayload).not.toHaveBeenCalled();
  });

  it("renders a download affordance when the server sniffs an unknown body as binary", async () => {
    renderViewer({
      payloadBytes: 100,
      contentType: null,
      result: { kind: "binary", bytes: 100, contentType: null },
    });
    await waitFor(() => expect(screen.getByText(/binary payload/i)).toBeInTheDocument());
  });

  it("renders a notice when the body was pruned", async () => {
    renderViewer({ payloadBytes: 7, contentType: "application/json", result: { kind: "pruned" } });
    await waitFor(() =>
      expect(screen.getByText(/pruned and is no longer available/i)).toBeInTheDocument(),
    );
  });

  it("renders an error state on failure", async () => {
    renderViewer({ payloadBytes: 7, contentType: "application/json", result: { kind: "error" } });
    await waitFor(() =>
      expect(screen.getByText(/couldn't load this payload/i)).toBeInTheDocument(),
    );
  });

  it("renders the body as escaped text — no markup injection", async () => {
    const xss = "<script>alert(1)</script>";
    const { container } = renderViewer({
      payloadBytes: xss.length,
      contentType: "text/plain",
      result: { kind: "text", text: xss, bytes: xss.length, contentType: "text/plain" },
    });
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(xss));
    expect(container.querySelector("script")).toBeNull();
  });
});
