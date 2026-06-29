import type { Cursor } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

// The action gates on the session; stub it so the unit runs without a cookie.
vi.mock("./session", () => ({
  verifySession: vi.fn(async () => ({
    userId: "u",
    orgId: "o",
    user: { name: "", email: "", image: null },
  })),
}));

// The DB-touching reads (over the tenant pool) — mocked; the glue is unit-tested in events/payloads tests.
const { loadMoreEvents, revealHeader, loadEventPayload } = vi.hoisted(() => ({
  loadMoreEvents: vi.fn(),
  revealHeader: vi.fn(),
  loadEventPayload: vi.fn(),
}));
vi.mock("./events", () => ({ loadMoreEvents, revealHeader }));
vi.mock("./payloads", () => ({ loadEventPayload }));

import { loadEventPayloadAction, loadMoreEventsAction, revealHeaderAction } from "./event-actions";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const CURSOR_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
const cursor: Cursor = { receivedAt: new Date("2026-06-28T00:00:00Z"), id: CURSOR_ID };

describe("loadMoreEventsAction", () => {
  it("returns the next page on success", async () => {
    loadMoreEvents.mockResolvedValueOnce({ items: [], nextCursor: null });
    const result = await loadMoreEventsAction({ endpointId: ENDPOINT_ID, cursor });
    expect(result).toEqual({ ok: true, items: [], nextCursor: null });
    expect(loadMoreEvents).toHaveBeenCalledWith(
      "o",
      ENDPOINT_ID,
      { receivedAt: cursor.receivedAt, id: CURSOR_ID },
      {},
    );
  });

  it("parses + threads the active filters (from → an instant lower bound)", async () => {
    loadMoreEvents.mockReset();
    loadMoreEvents.mockResolvedValueOnce({ items: [], nextCursor: null });
    await loadMoreEventsAction({
      endpointId: ENDPOINT_ID,
      cursor,
      filters: { provider: "stripe", from: "2026-06-01" },
    });
    expect(loadMoreEvents).toHaveBeenCalledWith(
      "o",
      ENDPOINT_ID,
      { receivedAt: cursor.receivedAt, id: CURSOR_ID },
      { provider: "stripe", receivedAfter: new Date("2026-06-01T00:00:00.000Z") },
    );
  });

  it("rejects a non-uuid endpoint id without paging", async () => {
    loadMoreEvents.mockReset();
    expect(await loadMoreEventsAction({ endpointId: "nope", cursor })).toEqual({ ok: false });
    expect(loadMoreEvents).not.toHaveBeenCalled();
  });

  it("rejects a cursor with a non-uuid id without paging", async () => {
    loadMoreEvents.mockReset();
    const bad = { receivedAt: new Date(), id: "not-a-uuid" } as Cursor;
    expect(await loadMoreEventsAction({ endpointId: ENDPOINT_ID, cursor: bad })).toEqual({
      ok: false,
    });
    expect(loadMoreEvents).not.toHaveBeenCalled();
  });

  it("rejects a cursor with an invalid date without paging", async () => {
    loadMoreEvents.mockReset();
    const bad = { receivedAt: new Date("not-a-date"), id: CURSOR_ID } as Cursor;
    expect(await loadMoreEventsAction({ endpointId: ENDPOINT_ID, cursor: bad })).toEqual({
      ok: false,
    });
    expect(loadMoreEvents).not.toHaveBeenCalled();
  });

  it("coerces a string receivedAt (server-action serialization) back to a Date", async () => {
    loadMoreEvents.mockReset();
    loadMoreEvents.mockResolvedValueOnce({ items: [], nextCursor: null });
    const wire = { receivedAt: "2026-06-28T00:00:00.000Z", id: CURSOR_ID } as unknown as Cursor;
    const result = await loadMoreEventsAction({ endpointId: ENDPOINT_ID, cursor: wire });
    expect(result.ok).toBe(true);
    expect(loadMoreEvents).toHaveBeenCalledWith(
      "o",
      ENDPOINT_ID,
      { receivedAt: new Date("2026-06-28T00:00:00.000Z"), id: CURSOR_ID },
      {},
    );
  });

  it("returns ok:false (no throw) when the pager faults", async () => {
    loadMoreEvents.mockReset();
    loadMoreEvents.mockRejectedValueOnce(new Error("db down"));
    expect(await loadMoreEventsAction({ endpointId: ENDPOINT_ID, cursor })).toEqual({ ok: false });
  });
});

describe("revealHeaderAction", () => {
  const input = { endpointId: ENDPOINT_ID, eventId: CURSOR_ID, index: 2 };

  it("returns the value for a valid sensitive header", async () => {
    revealHeader.mockReset();
    revealHeader.mockResolvedValueOnce({ value: "Bearer sk_live_x" });
    const result = await revealHeaderAction(input);
    expect(result).toEqual({ ok: true, value: "Bearer sk_live_x" });
    expect(revealHeader).toHaveBeenCalledWith("o", input);
  });

  it("returns ok:false when there is no sensitive header at the index", async () => {
    revealHeader.mockReset();
    revealHeader.mockResolvedValueOnce(null);
    expect(await revealHeaderAction({ ...input, index: 0 })).toEqual({ ok: false });
  });

  it("rejects a non-uuid endpointId or eventId without reading", async () => {
    revealHeader.mockReset();
    expect(await revealHeaderAction({ ...input, endpointId: "nope" })).toEqual({ ok: false });
    expect(await revealHeaderAction({ ...input, eventId: "nope" })).toEqual({ ok: false });
    expect(revealHeader).not.toHaveBeenCalled();
  });

  it("rejects a negative / non-integer index without reading", async () => {
    revealHeader.mockReset();
    expect(await revealHeaderAction({ ...input, index: -1 })).toEqual({ ok: false });
    expect(await revealHeaderAction({ ...input, index: 1.5 })).toEqual({ ok: false });
    expect(revealHeader).not.toHaveBeenCalled();
  });

  it("returns ok:false (no throw) when the read faults", async () => {
    revealHeader.mockReset();
    revealHeader.mockRejectedValueOnce(new Error("db down"));
    expect(await revealHeaderAction(input)).toEqual({ ok: false });
  });
});

describe("loadEventPayloadAction", () => {
  it("delegates to loadEventPayload with the session org", async () => {
    loadEventPayload.mockReset();
    loadEventPayload.mockResolvedValueOnce({
      kind: "text",
      text: "{}",
      bytes: 2,
      contentType: "application/json",
    });
    const result = await loadEventPayloadAction({ endpointId: ENDPOINT_ID, eventId: CURSOR_ID });
    expect(result).toEqual({ kind: "text", text: "{}", bytes: 2, contentType: "application/json" });
    expect(loadEventPayload).toHaveBeenCalledWith("o", ENDPOINT_ID, CURSOR_ID);
  });

  it("returns not_found for a malformed (non-string) input without reading", async () => {
    loadEventPayload.mockReset();
    expect(
      await loadEventPayloadAction({ endpointId: 123 as unknown as string, eventId: CURSOR_ID }),
    ).toEqual({ kind: "not_found" });
    expect(loadEventPayload).not.toHaveBeenCalled();
  });
});
