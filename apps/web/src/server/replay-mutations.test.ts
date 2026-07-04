import { describe, expect, it, vi } from "vitest";

import type { DeliverArgs, DeliverResult, DeliveryAttempt } from "@webhook-co/shared";

import {
  replayToDestination,
  ReplayConflictError,
  ReplayNotFoundError,
  type ClaimOutcome,
  type ReplayDeps,
} from "./replay-mutations";

const ORG = "22222222-2222-2222-2222-222222222222";
const EVENT = "33333333-3333-3333-3333-333333333333";
const DEST = "44444444-4444-4444-4444-444444444444";
const ATTEMPT_ID = "55555555-5555-5555-5555-555555555555";

const ATTEMPT: DeliveryAttempt = {
  id: ATTEMPT_ID,
  orgId: ORG,
  eventId: EVENT,
  target: JSON.stringify({ kind: "destination", destinationId: DEST }),
  idempotencyKey: "key-1",
  status: "pending",
  statusCode: null,
  attempt: 1,
  error: null,
  createdAt: new Date("2026-07-04T00:00:00Z"),
};

function claimed(
  overrides: Partial<Extract<ClaimOutcome, { kind: "claimed" }>> = {},
): ClaimOutcome {
  return {
    kind: "claimed",
    event: {
      endpointId: "ep-1",
      dedupKey: "dk-1",
      headers: [["content-type", "application/json"]],
    },
    destinationUrl: "https://hooks.example.com/in",
    signingSecrets: [],
    attempt: ATTEMPT,
    won: true,
    ...overrides,
  };
}

function deps(overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    claim: vi.fn(async () => claimed()),
    dispatch: vi.fn(async (): Promise<DeliverResult> => ({
      outcome: "delivered",
      status: 200,
      error: null,
      latencyMs: 12,
    })),
    finalize: vi.fn(async () => ({ ...ATTEMPT, status: "delivered", statusCode: 200 })),
    ...overrides,
  };
}

describe("replayToDestination", () => {
  it("claims with a fresh idempotency key + the serialized destination target", async () => {
    const d = deps();
    await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    expect(d.claim).toHaveBeenCalledOnce();
    const arg = (d.claim as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.orgId).toBe(ORG);
    expect(arg.eventId).toBe(EVENT);
    expect(arg.destinationId).toBe(DEST);
    expect(arg.target).toBe(JSON.stringify({ kind: "destination", destinationId: DEST }));
    // A fresh uuid per invocation (ADR-0016).
    expect(arg.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("throws ReplayNotFoundError when the event/destination isn't resolvable (no oracle)", async () => {
    await expect(
      replayToDestination(
        { orgId: ORG, eventId: EVENT, destinationId: DEST },
        deps({ claim: vi.fn(async () => ({ kind: "not_found" })) }),
      ),
    ).rejects.toBeInstanceOf(ReplayNotFoundError);
  });

  it("delivers via the dispatcher with the event's endpoint/dedup + destination url, then finalizes", async () => {
    const d = deps();
    const res = await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    const args: DeliverArgs = (d.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args).toMatchObject({
      orgId: ORG,
      endpointId: "ep-1",
      dedupKey: "dk-1",
      url: "https://hooks.example.com/in",
    });
    expect(res.status).toBe("delivered");
    expect(res.statusCode).toBe(200);
    expect(d.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: ATTEMPT_ID, status: "delivered", statusCode: 200 }),
    );
  });

  it("passes NO signing when the destination has no active secrets (unsigned)", async () => {
    const d = deps();
    await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    const args: DeliverArgs = (d.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.signing).toBeUndefined();
  });

  it("passes sealed signing (webhookId = the attempt id) when the destination has secrets", async () => {
    const d = deps({
      claim: vi.fn(async () =>
        claimed({
          signingSecrets: [
            { id: "k1", status: "active", sealed: { s: 1 }, context: { orgId: ORG } } as never,
          ],
        }),
      ),
    });
    await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    const args: DeliverArgs = (d.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.signing?.webhookId).toBe(ATTEMPT_ID);
    expect(args.signing?.secrets).toHaveLength(1);
  });

  it("records a 'failed' outcome (never throws) when the dispatcher RPC throws", async () => {
    const d = deps({
      dispatch: vi.fn(async () => {
        throw new Error("engine unreachable");
      }),
      finalize: vi.fn(async () => ({
        ...ATTEMPT,
        status: "failed",
        statusCode: null,
        error: "delivery dispatch failed",
      })),
    });
    const res = await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    expect(res.status).toBe("failed");
    // finalize is called with the synthesized failed outcome, not left pending.
    expect(d.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", statusCode: null }),
    );
  });

  it("renders a 'blocked' outcome truthfully (a successful resolve, not an error)", async () => {
    const d = deps({
      dispatch: vi.fn(async () => ({
        outcome: "blocked",
        status: null,
        error: "refused",
        latencyMs: 3,
      })),
      finalize: vi.fn(async () => ({
        ...ATTEMPT,
        status: "blocked",
        statusCode: null,
        error: "refused",
      })),
    });
    const res = await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    expect(res.status).toBe("blocked");
  });

  it("falls back to the claimed row + outcome when finalize returns null (already finalized/gone)", async () => {
    const d = deps({ finalize: vi.fn(async () => null) });
    const res = await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    expect(res.status).toBe("delivered");
    expect(res.id).toBe(ATTEMPT_ID);
  });

  it("does NOT re-deliver on an idempotent re-claim (won=false) — returns the existing row", async () => {
    const d = deps({
      claim: vi.fn(async () =>
        claimed({ won: false, attempt: { ...ATTEMPT, status: "delivered" } }),
      ),
    });
    const res = await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    expect(res.status).toBe("delivered");
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.finalize).not.toHaveBeenCalled();
  });

  it("rejects a non-won re-claim whose row is a DIFFERENT event (no false success) — ReplayConflictError", async () => {
    const d = deps({
      claim: vi.fn(async () =>
        claimed({
          won: false,
          attempt: {
            ...ATTEMPT,
            eventId: "99999999-9999-9999-9999-999999999999",
            status: "delivered",
          },
        }),
      ),
    });
    await expect(
      replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d),
    ).rejects.toBeInstanceOf(ReplayConflictError);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it("never throws for a finalize failure (delivery already happened) — returns the outcome", async () => {
    const d = deps({
      finalize: vi.fn(async () => {
        throw new Error("db blip");
      }),
    });
    const res = await replayToDestination({ orgId: ORG, eventId: EVENT, destinationId: DEST }, d);
    expect(res.status).toBe("delivered");
    expect(res.id).toBe(ATTEMPT_ID);
  });
});
