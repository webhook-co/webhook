import type { VerificationState } from "@webhook-co/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ReplayAttemptView, ReplayResult } from "@/server/replay-actions";
import type { DestinationItem } from "@/server/replay-destinations";

import { ReplayDialog } from "./replay-dialog";

// The component reads its org from the URL (useOrgSlug). Without a router, the hook returns "" and every
// link renders unprefixed — which is the deliberate fallback (a broken link, never a WRONG-ORG one), but it
// is not what a page under /org/{slug}/ actually renders. Give it a slug.
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

function destination(over: Partial<DestinationItem> = {}): DestinationItem {
  return {
    id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5070",
    url: "https://orders.example.com/webhooks",
    label: "Orders service",
    status: "active",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastValidatedAt: null,
    ordered: false,
    disabledAt: null,
    ...over,
  };
}

function attempt(over: Partial<ReplayAttemptView> = {}): ReplayAttemptView {
  return {
    id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5080",
    eventId: EVENT_ID,
    target: "https://orders.example.com/webhooks",
    idempotencyKey: "idem_1",
    status: "delivered",
    statusCode: 200,
    attempt: 1,
    error: null,
    createdAt: new Date("2026-07-01T01:00:00Z"),
    ...over,
  };
}

function renderDialog(
  destinations: readonly DestinationItem[],
  replay: (eventId: string, destinationId: string) => Promise<ReplayResult>,
  destinationsError = false,
  verificationState: VerificationState = "verified",
) {
  return render(
    <ReplayDialog
      open
      onClose={vi.fn()}
      eventId={EVENT_ID}
      verificationState={verificationState}
      destinations={destinations}
      destinationsError={destinationsError}
      replay={replay}
    />,
  );
}

describe("ReplayDialog", () => {
  it("shows a 'register first' link and no picker when there are no enabled destinations", () => {
    const replay = vi.fn();
    renderDialog([], replay);

    expect(screen.getByText(/register a replay destination first/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /manage destinations/i });
    expect(link).toHaveAttribute("href", "/org/acme/destinations");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^replay$/i })).not.toBeInTheDocument();
  });

  it("reads a LOAD ERROR as an error, not as 'you have none' — even with destinations present", () => {
    // The honesty fix: a transient load fault must never tell an org that HAS destinations to register one.
    renderDialog([destination()], vi.fn(), true);

    expect(screen.getByText(/couldn't load your destinations/i)).toBeInTheDocument();
    expect(screen.queryByText(/register a replay destination first/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^replay$/i })).not.toBeInTheDocument();
  });

  it("treats an auto-disabled destination as no target (empty state)", () => {
    renderDialog([destination({ disabledAt: new Date("2026-07-02T00:00:00Z") })], vi.fn());
    expect(screen.getByText(/register a replay destination first/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("replays the SELECTED destination id when Replay is clicked", async () => {
    const user = userEvent.setup();
    const a = destination({ id: "dest-a", label: "A" });
    const b = destination({ id: "dest-b", label: "B" });
    const replay = vi.fn(async (): Promise<ReplayResult> => ({ ok: true, attempt: attempt() }));
    renderDialog([a, b], replay);

    await user.selectOptions(screen.getByRole("combobox"), "dest-b");
    await user.click(screen.getByRole("button", { name: /^replay$/i }));

    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith(EVENT_ID, "dest-b");
  });

  it("renders a delivered result with an ok-tone status pill and the status code", async () => {
    const user = userEvent.setup();
    const replay = vi.fn(async (): Promise<ReplayResult> => ({
      ok: true,
      attempt: attempt({ status: "delivered", statusCode: 200 }),
    }));
    renderDialog([destination()], replay);

    await user.click(screen.getByRole("button", { name: /^replay$/i }));

    await waitFor(() => expect(screen.getByText("Delivered")).toBeInTheDocument());
    expect(screen.getByText(/· 200/)).toBeInTheDocument();
    expect(screen.getByText(/replay recorded/i)).toBeInTheDocument();
  });

  it("renders a BLOCKED result honestly — the blocked label, no misleading success claim", async () => {
    const user = userEvent.setup();
    const replay = vi.fn(async (): Promise<ReplayResult> => ({
      ok: true,
      attempt: attempt({
        status: "blocked",
        statusCode: null,
        error: "destination resolved to a private address",
      }),
    }));
    renderDialog([destination()], replay);

    await user.click(screen.getByRole("button", { name: /^replay$/i }));

    await waitFor(() => expect(screen.getByText("Blocked")).toBeInTheDocument());
    // The honest reason surfaces; no "Delivered"/"Success" wording anywhere.
    expect(screen.getByText(/refused by the delivery guard/i)).toBeInTheDocument();
    expect(screen.getByText(/private address/i)).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
    expect(screen.queryByText(/success/i)).not.toBeInTheDocument();
  });

  it("keeps the dialog open and shows the error banner on an {ok:false} fault", async () => {
    const user = userEvent.setup();
    const replay = vi.fn(async (): Promise<ReplayResult> => ({
      ok: false,
      error: "Replay is unavailable right now. Please try again shortly.",
    }));
    renderDialog([destination()], replay);

    await user.click(screen.getByRole("button", { name: /^replay$/i }));

    await waitFor(() =>
      expect(screen.getByText(/replay is unavailable right now/i)).toBeInTheDocument(),
    );
    // Still on the picker — the Replay button is present so they can retry.
    expect(screen.getByRole("button", { name: /^replay$/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("says the delivery is SIGNED for a verified event", () => {
    renderDialog([destination()], vi.fn(), false, "verified");
    expect(
      screen.getByText(/we sign the delivery so the destination can verify it/i),
    ).toBeInTheDocument();
  });

  it("says the delivery is UNSIGNED for an unattempted event (ADR-0103)", () => {
    renderDialog([destination()], vi.fn(), false, "unattempted");
    expect(screen.getByText(/we deliver it unsigned/i)).toBeInTheDocument();
    expect(screen.queryByText(/we sign the delivery/i)).not.toBeInTheDocument();
    // Still replayable (unsigned), so the picker + Replay stay.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^replay$/i })).toBeInTheDocument();
  });

  it("BLOCKS replay for a failed event — banner, no picker, no Replay (ADR-0103)", () => {
    const replay = vi.fn();
    renderDialog([destination()], replay, false, "failed");
    expect(screen.getByText(/signature was rejected/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^replay$/i })).not.toBeInTheDocument();
    expect(replay).not.toHaveBeenCalled();
  });

  it("fires replay only once for a same-tick double-click", async () => {
    let resolve!: (r: ReplayResult) => void;
    const replay = vi.fn(
      () =>
        new Promise<ReplayResult>((r) => {
          resolve = r;
        }),
    );
    renderDialog([destination()], replay);

    const button = screen.getByRole("button", { name: /^replay$/i });
    // Two synchronous clicks before the pending promise settles — the synchronous latch must swallow the 2nd.
    fireEvent.click(button);
    fireEvent.click(button);

    expect(replay).toHaveBeenCalledTimes(1);

    resolve({ ok: true, attempt: attempt() });
    await waitFor(() => expect(screen.getByText("Delivered")).toBeInTheDocument());
  });
});
