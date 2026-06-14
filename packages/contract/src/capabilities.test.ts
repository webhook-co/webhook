import { describe, expect, it } from "vitest";

import {
  auditVerify,
  CAPABILITIES,
  CAPABILITY_REGISTRY,
  eventsReplay,
  eventsTail,
} from "./capabilities";
import { CAPABILITY_ERRORS } from "./capability";

const EXPECTED_NAMES = [
  "endpoints.list",
  "endpoints.get",
  "events.list",
  "events.get",
  "events.tail",
  "events.replay",
  "audit.verify",
];

describe("capability registry", () => {
  it("registers exactly the wedge capabilities plus audit.verify", () => {
    expect([...CAPABILITY_REGISTRY.keys()].sort()).toEqual([...EXPECTED_NAMES].sort());
    expect(CAPABILITIES).toHaveLength(EXPECTED_NAMES.length);
  });

  it("each capability declares only known errors and a non-empty auth scope", () => {
    for (const cap of CAPABILITIES) {
      expect(cap.auth.scope.length).toBeGreaterThan(0);
      for (const e of cap.errors) expect(CAPABILITY_ERRORS).toContain(e);
    }
  });

  it("validates events.replay input and rejects a free-form URL target", () => {
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

  it("carries the gapless watermark on events.tail", () => {
    expect(eventsTail.semantics.streaming).toBe(true);
    expect(eventsTail.semantics.watermark?.deltaMs).toBeGreaterThan(0);
  });

  it("surfaces audit.verify on every GA surface with a read scope", () => {
    expect(auditVerify.auth.scope).toBe("audit:read");
    // No surfaceExempt — it must reach CLI/API/web/MCP identically.
    expect(auditVerify.surfaceExempt).toBeUndefined();
  });

  it("round-trips the audit.verify ok and break outputs", () => {
    const ok = auditVerify.output.safeParse({ ok: true, rowsVerified: 12 });
    expect(ok.success).toBe(true);

    const broken = auditVerify.output.safeParse({
      ok: false,
      rowsVerified: 4,
      break: { kind: "hash_mismatch", seq: 5, detail: "row_hash does not recompute" },
    });
    expect(broken.success).toBe(true);

    // An unknown break kind is rejected by the closed enum.
    const bad = auditVerify.output.safeParse({
      ok: false,
      rowsVerified: 4,
      break: { kind: "mystery", seq: 5, detail: "x" },
    });
    expect(bad.success).toBe(false);
  });

  it("round-trips a paginated output", () => {
    const parsed = CAPABILITY_REGISTRY.get("endpoints.list")!.output.safeParse({
      items: [],
      nextCursor: null,
    });
    expect(parsed.success).toBe(true);
  });
});
