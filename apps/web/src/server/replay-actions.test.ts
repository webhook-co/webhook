import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySession } = vi.hoisted(() => ({
  verifySession: vi.fn(async () => ({
    userId: "user-1",
    orgId: "org-1",
    user: { name: "A", email: "a@x.com", image: null },
  })),
}));
vi.mock("./session", () => ({ verifySession }));

const {
  replayToDestination,
  ReplayNotFoundError,
  DispatcherUnavailableError,
  ReplayConflictError,
} = vi.hoisted(() => {
  class ReplayNotFoundError extends Error {
    constructor() {
      super("nf");
      this.name = "ReplayNotFoundError";
    }
  }
  class DispatcherUnavailableError extends Error {
    constructor() {
      super("no dispatcher");
      this.name = "DispatcherUnavailableError";
    }
  }
  class ReplayConflictError extends Error {
    constructor() {
      super("conflict");
      this.name = "ReplayConflictError";
    }
  }
  return {
    replayToDestination: vi.fn(),
    ReplayNotFoundError,
    DispatcherUnavailableError,
    ReplayConflictError,
  };
});
vi.mock("./replay-mutations", () => ({
  replayToDestination,
  ReplayNotFoundError,
  DispatcherUnavailableError,
  ReplayConflictError,
}));

const { logActionError } = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => ({ logActionError }));

import { replayToDestinationAction } from "./replay-actions";

const EVENT = "33333333-3333-3333-3333-333333333333";
const DEST = "44444444-4444-4444-4444-444444444444";
const ATTEMPT = {
  id: "55555555-5555-5555-5555-555555555555",
  orgId: "org-1",
  eventId: EVENT,
  target: JSON.stringify({ kind: "destination", destinationId: DEST }),
  idempotencyKey: "k",
  status: "delivered" as const,
  statusCode: 200,
  attempt: 1,
  error: null,
  createdAt: new Date("2026-07-04T00:00:00Z"),
};

beforeEach(() => vi.clearAllMocks());

describe("replayToDestinationAction", () => {
  it("returns ok with a browser-safe attempt (orgId stripped)", async () => {
    replayToDestination.mockResolvedValue(ATTEMPT);
    const res = await replayToDestinationAction(EVENT, DEST);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempt).not.toHaveProperty("orgId");
      expect(res.attempt.status).toBe("delivered");
      expect(res.attempt.statusCode).toBe(200);
    }
    expect(replayToDestination).toHaveBeenCalledWith({
      orgId: "org-1",
      eventId: EVENT,
      destinationId: DEST,
    });
  });

  it("rejects a non-uuid eventId before calling the mutation", async () => {
    const res = await replayToDestinationAction("nope", DEST);
    expect(res.ok).toBe(false);
    expect(replayToDestination).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid destinationId before calling the mutation", async () => {
    const res = await replayToDestinationAction(EVENT, "nope");
    expect(res.ok).toBe(false);
    expect(replayToDestination).not.toHaveBeenCalled();
  });

  it("maps ReplayNotFoundError to a clean 'no longer exists' error", async () => {
    replayToDestination.mockRejectedValue(new ReplayNotFoundError());
    const res = await replayToDestinationAction(EVENT, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists|not found|couldn't find/i);
  });

  it("maps a missing dispatcher to a fail-closed 'unavailable' error", async () => {
    replayToDestination.mockRejectedValue(new DispatcherUnavailableError());
    const res = await replayToDestinationAction(EVENT, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unavailable|try again/i);
  });

  it("maps a ReplayConflictError to a retry message (never a false success)", async () => {
    replayToDestination.mockRejectedValue(new ReplayConflictError());
    const res = await replayToDestinationAction(EVENT, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/try again/i);
  });

  it("maps an unexpected error to a generic failure (scrubbed log)", async () => {
    replayToDestination.mockRejectedValue(new Error("boom"));
    const res = await replayToDestinationAction(EVENT, DEST);
    expect(res.ok).toBe(false);
    expect(logActionError).toHaveBeenCalled();
  });

  it("surfaces a non-delivered outcome as ok:true (blocked/failed are real results, not errors)", async () => {
    replayToDestination.mockResolvedValue({
      ...ATTEMPT,
      status: "blocked",
      statusCode: null,
      error: "refused",
    });
    const res = await replayToDestinationAction(EVENT, DEST);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempt.status).toBe("blocked");
  });
});
