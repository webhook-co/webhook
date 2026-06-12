import { describe, expect, it } from "vitest";

import { CAPABILITIES, CAPABILITY_REGISTRY, eventsReplay, eventsTail } from "./capabilities";
import { CAPABILITY_ERRORS } from "./capability";

const EXPECTED_NAMES = [
  "endpoints.list",
  "endpoints.get",
  "events.list",
  "events.get",
  "events.tail",
  "events.replay",
];

describe("capability registry", () => {
  it("freezes exactly the six wedge capabilities", () => {
    expect([...CAPABILITY_REGISTRY.keys()].sort()).toEqual([...EXPECTED_NAMES].sort());
    expect(CAPABILITIES).toHaveLength(6);
  });

  it("each capability declares only known errors and a non-empty auth scope", () => {
    for (const cap of CAPABILITIES) {
      expect(cap.auth.scope.length).toBeGreaterThan(0);
      for (const e of cap.errors) expect(CAPABILITY_ERRORS).toContain(e);
    }
  });

  it("validates events.replay input and rejects a free-form URL target (H6)", () => {
    const ok = eventsReplay.input.safeParse({
      eventId: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
      target: { kind: "localhost-tunnel", sessionId: "sess_1" },
      idempotencyKey: "idem_1",
    });
    expect(ok.success).toBe(true);

    const bad = eventsReplay.input.safeParse({
      eventId: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
      target: { kind: "url", url: "http://169.254.169.254/" },
      idempotencyKey: "idem_1",
    });
    expect(bad.success).toBe(false);
  });

  it("requires an idempotency key on the idempotent replay capability", () => {
    expect(eventsReplay.semantics.idempotent).toBe(true);
    const missing = eventsReplay.input.safeParse({
      eventId: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
      target: { kind: "localhost-tunnel", sessionId: "s" },
      idempotencyKey: "",
    });
    expect(missing.success).toBe(false);
  });

  it("carries the gapless watermark on events.tail (§0.10, H5)", () => {
    expect(eventsTail.semantics.streaming).toBe(true);
    expect(eventsTail.semantics.watermark?.deltaMs).toBeGreaterThan(0);
  });

  it("round-trips a paginated output", () => {
    const parsed = CAPABILITY_REGISTRY.get("endpoints.list")!.output.safeParse({
      items: [],
      nextCursor: null,
    });
    expect(parsed.success).toBe(true);
  });
});
