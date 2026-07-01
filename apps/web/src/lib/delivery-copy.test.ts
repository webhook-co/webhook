import { describe, expect, it } from "vitest";

import { deliveryCopy } from "./delivery-copy";

// A fixed "now" so relative-time hints are deterministic.
const NOW = new Date("2026-07-01T12:00:00.000Z");

describe("deliveryCopy — honest tone + label + hint per delivery state", () => {
  it("delivered → ok, plain label, no hint", () => {
    const c = deliveryCopy("delivered", { now: NOW });
    expect(c.tone).toBe("ok");
    expect(c.label).toBe("Delivered");
    expect(c.hint).toBeUndefined();
  });

  it("queued → neutral 'Queued'", () => {
    const c = deliveryCopy("queued", { now: NOW });
    expect(c.tone).toBe("neutral");
    expect(c.label).toBe("Queued");
  });

  it("pending with a future nextRetryAt → neutral 'Retrying' + a relative hint", () => {
    const c = deliveryCopy("pending", {
      now: NOW,
      nextRetryAt: new Date("2026-07-01T12:04:00.000Z"),
    });
    expect(c.tone).toBe("neutral");
    expect(c.label).toBe("Retrying");
    expect(c.hint).toBe("Retrying in 4m");
  });

  it("pending with a past/na nextRetryAt → neutral 'In progress', no stale hint", () => {
    const c = deliveryCopy("pending", {
      now: NOW,
      nextRetryAt: new Date("2026-07-01T11:59:00.000Z"),
    });
    expect(c.tone).toBe("neutral");
    expect(c.label).toBe("In progress");
    expect(c.hint).toBeUndefined();
  });

  it("pending with no nextRetryAt → 'In progress'", () => {
    const c = deliveryCopy("pending", { now: NOW, nextRetryAt: null });
    expect(c.label).toBe("In progress");
  });

  it("failed → danger 'Failed'", () => {
    const c = deliveryCopy("failed", { now: NOW });
    expect(c.tone).toBe("danger");
    expect(c.label).toBe("Failed");
  });

  it("blocked → danger 'Blocked' + a reason true for BOTH guard paths (no malice implied)", () => {
    const c = deliveryCopy("blocked", { now: NOW });
    expect(c.tone).toBe("danger");
    expect(c.label).toBe("Blocked");
    // Covers both the structural-URL reject and the resolves-to-private refusal; the detail view's per-row
    // `error` carries the exact reason.
    expect(c.hint).toBe("Refused by the delivery guard — the destination isn't allowed");
  });

  it("dead → danger 'Undelivered' + gave-up hint", () => {
    const c = deliveryCopy("dead", { now: NOW });
    expect(c.tone).toBe("danger");
    expect(c.label).toBe("Undelivered");
    expect(c.hint).toBe("Gave up after the last retry");
  });

  it("cancelled → neutral 'Cancelled' + destination-removed reason", () => {
    const c = deliveryCopy("cancelled", { now: NOW });
    expect(c.tone).toBe("neutral");
    expect(c.label).toBe("Cancelled");
    expect(c.hint).toBe("The destination was removed before this could be delivered");
  });

  it("forwarded → neutral 'Forwarded' (legacy localhost replay)", () => {
    const c = deliveryCopy("forwarded", { now: NOW });
    expect(c.tone).toBe("neutral");
    expect(c.label).toBe("Forwarded");
  });

  it("formats longer relative hints in hours", () => {
    const c = deliveryCopy("pending", {
      now: NOW,
      nextRetryAt: new Date("2026-07-01T14:00:00.000Z"),
    });
    expect(c.hint).toBe("Retrying in 2h");
  });

  it("rounds sub-minute retries up to the next minute (never 'in 0m')", () => {
    const c = deliveryCopy("pending", {
      now: NOW,
      nextRetryAt: new Date("2026-07-01T12:00:30.000Z"),
    });
    expect(c.hint).toBe("Retrying in 1m");
  });
});
