import type { VerificationResult } from "@webhook-co/webhooks-spec";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeleteEventResult } from "@/server/event-actions";
import type { EventDetailItem, RevealHeaderResult } from "@/server/events";
import type { PayloadResult } from "@/server/payloads";
import type { ReplayResult } from "@/server/replay-actions";

import { EventDetail } from "./event-detail";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

// `push` (and the default action mocks) are module-level, so reset call history between tests — otherwise a
// prior test's navigation leaks into the next's "did NOT navigate" assertion.
afterEach(() => vi.clearAllMocks());

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

function detail(over: Partial<EventDetailItem> = {}): EventDetailItem {
  return {
    id: EVENT_ID,
    endpointId: ENDPOINT_ID,
    receivedAt: new Date("2026-06-28T12:00:00Z"),
    provider: "stripe",
    dedupKey: "evt_123",
    dedupStrategy: "sw_webhook_id",
    verified: true,
    payloadBytes: 42,
    contentType: "application/json",
    headers: [{ name: "user-agent", value: "Stripe/1.2.3", sensitive: false }],
    providerEventId: "evt_123",
    externalId: null,
    verification: { ok: true, keyId: "key_1", scheme: "stripe" },
    ...over,
  };
}

// Default reveal action: never called in most tests; specific tests pass their own.
const noReveal = vi.fn(async (): Promise<RevealHeaderResult> => ({ ok: false }));
// Default payload load: never resolves, so the viewer stays in "Loading…" and fires no post-mount state
// update in the metadata/header tests (the payload viewer has its own test).
const noLoadPayload = vi.fn(() => new Promise<PayloadResult>(() => {}));
// Default replay action: never called in these tests (the replay dialog has its own test).
const noReplay = vi.fn(async (): Promise<ReplayResult> => ({ ok: false, error: "not used" }));
// Default delete action: resolves ok; specific tests pass their own to assert failure / call args.
const okDelete = vi.fn(async (): Promise<DeleteEventResult> => ({ ok: true }));

function renderDetail(
  event: EventDetailItem,
  revealHeader: (input: {
    endpointId: string;
    eventId: string;
    index: number;
  }) => Promise<RevealHeaderResult> = noReveal,
  deleteEvent: (input: { eventId: string }) => Promise<DeleteEventResult> = okDelete,
) {
  return render(
    <EventDetail
      event={event}
      endpointId={ENDPOINT_ID}
      revealHeader={revealHeader}
      loadPayload={noLoadPayload}
      destinations={[]}
      replay={noReplay}
      deleteEvent={deleteEvent}
    />,
  );
}

describe("EventDetail", () => {
  it("renders the event metadata", () => {
    renderDetail(detail());
    expect(screen.getByText(EVENT_ID)).toBeInTheDocument();
    expect(screen.getByText("Stripe")).toBeInTheDocument(); // provider rendered as its display name
    expect(screen.getByText("application/json")).toBeInTheDocument();
    expect(screen.getByText("42 bytes")).toBeInTheDocument();
  });

  it("shows a Verified diagnostic naming the scheme + key for a passing event", () => {
    renderDetail(detail());
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText(/scheme \(key key_1\)/i)).toBeInTheDocument();
  });

  it("shows a NEUTRAL 'not attempted' diagnostic (not a failure) when verification is null", () => {
    renderDetail(detail({ verified: false, verification: null }));
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.getByText(/no signing secret was configured/i)).toBeInTheDocument();
  });

  it("shows a failure diagnostic when verification failed", () => {
    const verification: VerificationResult = {
      ok: false,
      reason: { code: "WRONG_SECRET", confidence: "medium" },
    };
    renderDetail(detail({ verified: false, verification }));
    expect(screen.getByText("Verification failed")).toBeInTheDocument();
    expect(screen.getByText(/secret is likely wrong/i)).toBeInTheDocument();
  });

  it("renders an attacker-controlled (non-sensitive) header value as ESCAPED text (XSS)", () => {
    const xss = "<script>alert(1)</script>";
    const { container } = renderDetail(
      detail({ headers: [{ name: "x-custom", value: xss, sensitive: false }] }),
    );
    expect(screen.getByText(xss)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("a sensitive header value is NOT in the props/DOM; Reveal fetches it via the action", async () => {
    const user = userEvent.setup();
    const revealHeader = vi.fn(async (): Promise<RevealHeaderResult> => ({
      ok: true,
      value: "Bearer super-secret-token",
    }));
    renderDetail(
      // sensitive header: value is REDACTED server-side (null), only the flag ships to the client
      detail({ headers: [{ name: "Authorization", value: null, sensitive: true }] }),
      revealHeader,
    );
    expect(screen.queryByText("Bearer super-secret-token")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /reveal/i }));
    expect(revealHeader).toHaveBeenCalledWith({
      endpointId: ENDPOINT_ID,
      eventId: EVENT_ID,
      index: 0,
    });
    await waitFor(() => expect(screen.getByText("Bearer super-secret-token")).toBeInTheDocument());
  });

  it("renders a REVEALED sensitive value as escaped text too (XSS on the fetched value)", async () => {
    const user = userEvent.setup();
    const xss = "<script>alert(2)</script>";
    const revealHeader = vi.fn(async (): Promise<RevealHeaderResult> => ({ ok: true, value: xss }));
    const { container } = renderDetail(
      detail({ headers: [{ name: "x-api-key", value: null, sensitive: true }] }),
      revealHeader,
    );
    await user.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(screen.getByText(xss)).toBeInTheDocument());
    expect(container.querySelector("script")).toBeNull();
  });

  it("an empty revealed value unmasks to a muted (empty), not a blank cell", async () => {
    const user = userEvent.setup();
    const revealHeader = vi.fn(async (): Promise<RevealHeaderResult> => ({ ok: true, value: "" }));
    renderDetail(
      detail({ headers: [{ name: "Authorization", value: null, sensitive: true }] }),
      revealHeader,
    );
    await user.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(screen.getByText("(empty)")).toBeInTheDocument());
    // the Reveal button is gone (it's revealed, just empty)
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
  });

  it("surfaces a reveal failure as an alert without crashing", async () => {
    const user = userEvent.setup();
    const revealHeader = vi.fn(async (): Promise<RevealHeaderResult> => ({ ok: false }));
    renderDetail(
      detail({ headers: [{ name: "Authorization", value: null, sensitive: true }] }),
      revealHeader,
    );
    await user.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't reveal/i));
  });

  it("does not mask an allowlisted header", () => {
    renderDetail(
      detail({ headers: [{ name: "content-type", value: "application/json", sensitive: false }] }),
    );
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
  });

  it("offers the truthful CLI commands to inspect + replay", () => {
    renderDetail(detail());
    expect(screen.getByText(`wbhk events payload ${EVENT_ID}`)).toBeInTheDocument();
    expect(
      screen.getByText(`wbhk replay ${EVENT_ID} --forward http://localhost:3000/webhooks`),
    ).toBeInTheDocument();
  });

  it("never uses dangerouslySetInnerHTML for the headers surface", () => {
    const { container } = renderDetail(
      detail({ headers: [{ name: "x-custom", value: "<b>hi</b>", sensitive: false }] }),
    );
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>hi</b>")).toBeInTheDocument();
  });

  it("enables 'Replay to a destination' for a verified event", () => {
    renderDetail(detail());
    expect(screen.getByRole("button", { name: /replay to a destination/i })).toBeEnabled();
  });

  it("enables 'Replay to a destination' for an unattempted (unverified) event", () => {
    renderDetail(detail({ verified: false, verification: null }));
    expect(screen.getByRole("button", { name: /replay to a destination/i })).toBeEnabled();
  });

  it("disables 'Replay to a destination' and explains it for a FAILED event (ADR-0103)", () => {
    const verification: VerificationResult = {
      ok: false,
      reason: { code: "WRONG_SECRET", confidence: "medium" },
    };
    renderDetail(detail({ verified: false, verification }));
    expect(screen.getByRole("button", { name: /replay to a destination/i })).toBeDisabled();
    // The button pre-explains why (rather than letting the user click through to an error toast).
    expect(screen.getByText(/rejected signature can't be replayed/i)).toBeInTheDocument();
  });

  describe("delete (S3 UI)", () => {
    it("requires a confirm dialog — the header Delete never deletes on its own", async () => {
      const del = vi.fn(async (): Promise<DeleteEventResult> => ({ ok: true }));
      renderDetail(detail(), noReveal, del);
      // The destructive action isn't the header button; it only OPENS the confirmation.
      await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
      expect(del).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toHaveTextContent(/delete this event\?/i);
    });

    it("deletes on confirm and navigates back to the events list", async () => {
      const del = vi.fn(async (): Promise<DeleteEventResult> => ({ ok: true }));
      renderDetail(detail(), noReveal, del);
      await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
      await userEvent.click(screen.getByRole("button", { name: /delete event/i }));
      expect(del).toHaveBeenCalledWith({ eventId: EVENT_ID });
      await waitFor(() => expect(push).toHaveBeenCalledWith(`/endpoints/${ENDPOINT_ID}/events`));
    });

    it("shows an error and does NOT navigate when the delete fails", async () => {
      const del = vi.fn(async (): Promise<DeleteEventResult> => ({ ok: false }));
      renderDetail(detail(), noReveal, del);
      await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
      await userEvent.click(screen.getByRole("button", { name: /delete event/i }));
      expect(await screen.findByText(/couldn't delete this event/i)).toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
    });
  });
});
