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

  it("encodeClientFrame round-trips an ack through the server's parseClientFrame", () => {
    expect(parseClientFrame(encodeClientFrame({ type: "ack", cursor: "c9" }))).toEqual({
      type: "ack",
      cursor: "c9",
    });
  });
});
