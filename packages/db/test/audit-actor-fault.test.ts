import { CapabilityFault } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { requireAuditActor } from "../src/audit-actor-fault";

describe("requireAuditActor", () => {
  it("attributes an api-key request to the presenting key", () => {
    expect(requireAuditActor({ orgId: "o1", scopes: [], keyId: "k_1" })).toEqual({
      kind: "key",
      id: "k_1",
    });
  });

  it("attributes a session-only principal to the user", () => {
    expect(requireAuditActor({ orgId: "o1", scopes: [], userId: "u_1" })).toEqual({
      kind: "user",
      id: "u_1",
    });
  });

  // An audited mutation whose principal we cannot identify must REFUSE, not quietly write a null actor —
  // the null actor is the defect this vocabulary exists to remove. It must refuse as a TYPED fault the
  // surfaces already map (a 401), not as a bare Error: an unmapped throw escapes the capability handler's
  // fault boundary as an opaque 500 with a stack-shaped log line and no code for the caller.
  it("refuses with a typed UNAUTHORIZED fault when the principal identifies neither", () => {
    expect(() => requireAuditActor({ orgId: "o1", scopes: [] })).toThrow(CapabilityFault);
    try {
      requireAuditActor({ orgId: "o1", scopes: [] });
      expect.unreachable("must not return an actor for an unidentifiable principal");
    } catch (error) {
      expect((error as CapabilityFault).code).toBe("UNAUTHORIZED");
    }
  });
});
