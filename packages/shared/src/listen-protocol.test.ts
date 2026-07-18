import { describe, expect, it } from "vitest";

import {
  ServerFrameSchema,
  encodeClientFrame,
  encodeServerFrame,
  parseClientFrame,
  parseServerFrame,
  type ServerFrame,
} from "./listen-protocol";

// A valid events.tail summary (the event-frame payload). UUIDs + enum values must be real or
// EventSummarySchema rejects them — provider/dedupStrategy come from the shared enums.
function summary() {
  return {
    id: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    endpointId: crypto.randomUUID(),
    receivedAt: new Date("2026-06-10T12:00:00.000Z"),
    provider: "stripe" as const,
    dedupKey: "dk_1",
    dedupStrategy: "content_hash" as const,
    verified: true,
  };
}

describe("listen-protocol — client frames (untrusted input)", () => {
  it("accepts a well-formed ack frame", () => {
    expect(parseClientFrame(JSON.stringify({ type: "ack", cursor: "c1" }))).toEqual({
      type: "ack",
      cursor: "c1",
    });
  });

  it("decodes an ArrayBuffer payload the same as a string", () => {
    const buf = new TextEncoder().encode(JSON.stringify({ type: "ack", cursor: "c2" })).buffer;
    expect(parseClientFrame(buf)).toEqual({ type: "ack", cursor: "c2" });
  });

  it("rejects malformed JSON → null (no throw)", () => {
    expect(parseClientFrame("{not json")).toBeNull();
  });

  it("rejects an unknown frame type → null", () => {
    // A client must not be able to inject a server-only frame type.
    expect(parseClientFrame(JSON.stringify({ type: "event", cursor: "c" }))).toBeNull();
  });

  it("rejects an ack missing its cursor → null", () => {
    expect(parseClientFrame(JSON.stringify({ type: "ack" }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "ack", cursor: 7 }))).toBeNull();
  });
});

describe("listen-protocol — server frames", () => {
  it("round-trips a ready frame through JSON + schema", () => {
    const frame: ServerFrame = { type: "ready", sessionId: "s1", watermarkDeltaMs: 5000 };
    expect(ServerFrameSchema.parse(JSON.parse(encodeServerFrame(frame)))).toEqual(frame);
  });

  // #25 — the ready frame carries the DO's seeded resume cursor so a streaming client has a position
  // from CONNECT (before the first event). The field is OPTIONAL + NULLABLE for cross-version back-compat:
  // the CLI is versioned independently, so a NEW client must tolerate an OLD engine that omits it, and an
  // OLD client must ignore a NEW engine that includes it.
  it("round-trips a ready frame that CARRIES a seed cursor", () => {
    const frame: ServerFrame = {
      type: "ready",
      sessionId: "s1",
      watermarkDeltaMs: 5000,
      cursor: "opaque.seed.cursor",
    };
    const parsed = ServerFrameSchema.parse(JSON.parse(encodeServerFrame(frame)));
    expect(parsed).toEqual(frame);
    if (parsed.type === "ready") expect(parsed.cursor).toBe("opaque.seed.cursor");
  });

  it("still parses an OLD ready frame with NO cursor (back-compat, new client ⇄ old engine)", () => {
    // The wire shape an engine that predates #25 sends: no `cursor` key at all. A new client must accept it.
    const wire = JSON.stringify({ type: "ready", sessionId: "s1", watermarkDeltaMs: 5000 });
    const parsed = ServerFrameSchema.parse(JSON.parse(wire));
    expect(parsed).toEqual({ type: "ready", sessionId: "s1", watermarkDeltaMs: 5000 });
    if (parsed.type === "ready") expect(parsed.cursor).toBeUndefined();
  });

  it("accepts a ready frame whose cursor is explicitly null (seeded from the oldest / no seed)", () => {
    const wire = JSON.stringify({
      type: "ready",
      sessionId: "s1",
      watermarkDeltaMs: 5000,
      cursor: null,
    });
    const parsed = ServerFrameSchema.parse(JSON.parse(wire));
    expect(parsed.type).toBe("ready");
    if (parsed.type === "ready") expect(parsed.cursor).toBeNull();
  });

  it("rejects a ready frame whose cursor is the wrong type (not string/null)", () => {
    const wire = JSON.stringify({
      type: "ready",
      sessionId: "s1",
      watermarkDeltaMs: 5000,
      cursor: 7,
    });
    expect(() => ServerFrameSchema.parse(JSON.parse(wire))).toThrow();
    // parseServerFrame is the untrusted-input path: a bad cursor type → null, never a throw.
    expect(parseServerFrame(wire)).toBeNull();
  });

  it("encodes an event frame's Date as ISO and coerces it back on parse", () => {
    const frame: ServerFrame = { type: "event", summary: summary(), cursor: "cur" };
    const wire = encodeServerFrame(frame);
    expect(wire).toContain("2026-06-10T12:00:00.000Z"); // Date serialized as ISO on the wire
    const parsed = ServerFrameSchema.parse(JSON.parse(wire));
    expect(parsed.type).toBe("event");
    if (parsed.type === "event") {
      expect(parsed.summary.receivedAt).toBeInstanceOf(Date); // coerced ISO → Date
      expect(parsed.summary.id).toBe(frame.summary.id);
    }
  });

  it("carries a recoverable error frame", () => {
    const frame: ServerFrame = { type: "error", code: "POLL_DEGRADED", message: "transient" };
    expect(ServerFrameSchema.parse(JSON.parse(encodeServerFrame(frame)))).toEqual(frame);
  });

  it("round-trips a status frame (caughtUp + optional capped lag)", () => {
    const behind: ServerFrame = { type: "status", caughtUp: false, lag: { backlogCount: 12 } };
    expect(ServerFrameSchema.parse(JSON.parse(encodeServerFrame(behind)))).toEqual(behind);

    // lag is optional — a bare caught-up transition needs no backlog.
    const caught: ServerFrame = { type: "status", caughtUp: true };
    expect(ServerFrameSchema.parse(JSON.parse(encodeServerFrame(caught)))).toEqual(caught);
  });
});

describe("listen-protocol — client-side (the CLI consuming the tunnel)", () => {
  it("parseServerFrame accepts a ready frame", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "ready", sessionId: "s1", watermarkDeltaMs: 5000 })),
    ).toEqual({ type: "ready", sessionId: "s1", watermarkDeltaMs: 5000 });
  });

  it("parseServerFrame round-trips an event frame (ISO → Date) and decodes an ArrayBuffer", () => {
    const frame: ServerFrame = { type: "event", summary: summary(), cursor: "cur" };
    const wire = encodeServerFrame(frame);
    const parsed = parseServerFrame(new TextEncoder().encode(wire).buffer);
    expect(parsed?.type).toBe("event");
    if (parsed?.type === "event") {
      expect(parsed.summary.receivedAt).toBeInstanceOf(Date);
      expect(parsed.summary.id).toBe(frame.summary.id);
    }
  });

  it("parseServerFrame returns null on garbage or a client-only frame type", () => {
    expect(parseServerFrame("{not json")).toBeNull();
    // an `ack` is a CLIENT frame — the client must not accept it as a server frame.
    expect(parseServerFrame(JSON.stringify({ type: "ack", cursor: "c" }))).toBeNull();
  });

  it("parseServerFrame accepts a status frame and additive-skips an unknown frame type", () => {
    expect(
      parseServerFrame(
        JSON.stringify({ type: "status", caughtUp: true, lag: { backlogCount: 3 } }),
      ),
    ).toEqual({ type: "status", caughtUp: true, lag: { backlogCount: 3 } });
    // additive-safe: a future/unknown server frame type → null (an old client skips it, never throws).
    expect(parseServerFrame(JSON.stringify({ type: "future", x: 1 }))).toBeNull();
  });

  it("encodeClientFrame round-trips an ack through the server's parseClientFrame", () => {
    expect(parseClientFrame(encodeClientFrame({ type: "ack", cursor: "c9" }))).toEqual({
      type: "ack",
      cursor: "c9",
    });
  });
});
