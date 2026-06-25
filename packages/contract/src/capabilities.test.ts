import { describe, expect, it } from "vitest";

import {
  auditVerify,
  CAPABILITIES,
  CAPABILITY_REGISTRY,
  endpointsCreate,
  eventsReplay,
  eventsTail,
} from "./capabilities";
import {
  CAPABILITY_ERRORS,
  CAPABILITY_SCOPES,
  requiredSurfaces,
  RESERVED_SCOPES,
} from "./capability";

const EXPECTED_NAMES = [
  "endpoints.list",
  "endpoints.get",
  "endpoints.create",
  "events.list",
  "events.get",
  "events.getPayload",
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

  it("surfaces audit.verify on CLI/API/MCP with a read scope (web deferred with the dashboard)", () => {
    expect(auditVerify.auth.scope).toBe("audit:read");
    // The compliance verifier reaches the live bearer surfaces identically; only `web` is
    // exempt, and only because the whole dashboard epic is deferred (same reason as every
    // read capability). It is NOT exempt on cli/api/mcp.
    expect(requiredSurfaces(auditVerify)).toEqual(["api", "cli", "mcp"]);
    expect(Object.keys(auditVerify.surfaceExempt ?? {})).toEqual(["web"]);
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

  it("events.tail output carries the additive cursor-contract fields and still validates without them", () => {
    const withMeta = eventsTail.output.safeParse({
      items: [],
      nextCursor: null,
      headCursor: "sig.cursor",
      caughtUp: true,
      lag: { backlogCount: 42, headLagMs: 1500 },
    });
    expect(withMeta.success).toBe(true);

    // Additive: a producer that omits the new fields still validates (no break for existing consumers).
    const without = eventsTail.output.safeParse({ items: [], nextCursor: null });
    expect(without.success).toBe(true);

    // lag.backlogCount is required when lag is present — a malformed lag is rejected.
    const badLag = eventsTail.output.safeParse({
      items: [],
      nextCursor: null,
      lag: { headLagMs: 5 },
    });
    expect(badLag.success).toBe(false);
  });

  it("events.list output carries headCursor only (no caughtUp/lag on a newest-first browse)", () => {
    const list = CAPABILITY_REGISTRY.get("events.list")!.output.safeParse({
      items: [],
      nextCursor: null,
      headCursor: "sig.cursor",
    });
    expect(list.success).toBe(true);
  });
});

describe("endpoints.create", () => {
  it("is the write capability — endpoints:write scope, bound on api/cli/mcp, web deferred, not idempotent", () => {
    expect(endpointsCreate.auth.scope).toBe("endpoints:write");
    expect(endpointsCreate.semantics.idempotent).toBeUndefined();
    expect(requiredSurfaces(endpointsCreate)).toEqual(["api", "cli", "mcp"]);
    expect(Object.keys(endpointsCreate.surfaceExempt ?? {})).toEqual(["web"]);
    // FORBIDDEN must be declarable so an under-scoped caller maps to 403; RATE_LIMITED for the soft cap.
    expect(endpointsCreate.errors).toContain("FORBIDDEN");
    expect(endpointsCreate.errors).toContain("RATE_LIMITED");
  });

  it("endpoints:write is in the closed grantable scope set", () => {
    expect(new Set<string>(CAPABILITY_SCOPES).has("endpoints:write")).toBe(true);
  });

  it("validates the name input (trims, requires 1..200 chars)", () => {
    expect(endpointsCreate.input.safeParse({ name: "stripe prod" }).success).toBe(true);
    expect(endpointsCreate.input.safeParse({ name: "" }).success).toBe(false);
    expect(endpointsCreate.input.safeParse({ name: "   " }).success).toBe(false); // trims to empty
    expect(endpointsCreate.input.safeParse({ name: "x".repeat(201) }).success).toBe(false);
    expect(endpointsCreate.input.safeParse({}).success).toBe(false);
  });

  it("output is an endpoint plus a one-time ingestUrl", () => {
    const ok = endpointsCreate.output.safeParse({
      id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
      orgId: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061",
      name: "stripe prod",
      paused: false,
      createdAt: "2026-06-25T00:00:00.000Z",
      ingestUrl: "https://wbhk.my/whep_abc",
    });
    expect(ok.success).toBe(true);
    // A non-URL ingestUrl is rejected by z.url().
    const bad = endpointsCreate.output.safeParse({
      id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
      orgId: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061",
      name: "stripe prod",
      paused: false,
      createdAt: "2026-06-25T00:00:00.000Z",
      ingestUrl: "not a url",
    });
    expect(bad.success).toBe(false);
  });
});

describe("RESERVED_SCOPES", () => {
  it("reserves the keys:manage scope name", () => {
    expect(RESERVED_SCOPES).toContain("keys:manage");
  });

  it("stays DISJOINT from the closed CAPABILITY_SCOPES (a reserved name never widens what verifyBearer grants)", () => {
    const grantable = new Set<string>(CAPABILITY_SCOPES);
    for (const reserved of RESERVED_SCOPES) {
      expect(grantable.has(reserved)).toBe(false);
    }
  });
});
