import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IngestUrlReveal } from "./ingest-url-reveal";

// IngestUrlReveal is the async server component that owns the always-shown ingest URL (moved off the page's
// blocking render path — the page streams it in behind a <Suspense>). It maps the reveal result to the URL +
// copy affordance, or the rotate-to-reveal hint when there's no recoverable copy. The retry/fail-soft logic
// lives in revealEndpointIngestUrl (its own suite); here we mock that seam and prove the render mapping.
vi.mock("@/server/endpoint-reveal", () => ({
  revealEndpointIngestUrl: vi.fn(),
  recordIngestUrlDisclosure: vi.fn(async () => {}),
}));
import { recordIngestUrlDisclosure, revealEndpointIngestUrl } from "@/server/endpoint-reveal";

const reveal = vi.mocked(revealEndpointIngestUrl);
const record = vi.mocked(recordIngestUrlDisclosure);
const props = { orgId: "org-1", userId: "u-1", endpointId: "ep-1" };

beforeEach(() => reveal.mockReset());

describe("IngestUrlReveal", () => {
  it("renders the ingest URL with a copy affordance when a token is revealed", async () => {
    reveal.mockResolvedValue({ kind: "url", url: "https://wbhk.my/whep_shown" });
    render(await IngestUrlReveal(props));
    expect(screen.getByText("https://wbhk.my/whep_shown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("advises rotate ONLY for a genuinely token-less endpoint (no-copy)", async () => {
    reveal.mockResolvedValue({ kind: "no-copy" });
    render(await IngestUrlReveal(props));
    expect(screen.getByText(/rotate to mint a fresh one/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("advises REFRESH (not rotate) on a transient reveal failure — rotating would break a working URL", async () => {
    reveal.mockResolvedValue({ kind: "unavailable" });
    render(await IngestUrlReveal(props));
    expect(screen.getByText(/refresh to try again/i)).toBeInTheDocument();
    // Critically: NO rotate advice for a transient failure (the token still exists).
    expect(screen.queryByText(/rotate/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });
});

describe("IngestUrlReveal — disclosure audit (S.9)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the disclosure when a URL is actually shown", async () => {
    reveal.mockResolvedValue({ kind: "url", url: "https://wbhk.my/tok" });
    render(await IngestUrlReveal(props));
    expect(record).toHaveBeenCalledWith({ orgId: "org-1", userId: "u-1", endpointId: "ep-1" });
  });

  it("does NOT record when nothing was disclosed (no-copy / unavailable)", async () => {
    for (const kind of ["no-copy", "unavailable"] as const) {
      vi.clearAllMocks();
      reveal.mockResolvedValue({ kind });
      render(await IngestUrlReveal(props));
      expect(record).not.toHaveBeenCalled();
    }
  });
});
