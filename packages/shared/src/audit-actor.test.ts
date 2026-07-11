import { describe, expect, it } from "vitest";

import {
  auditActorFromContext,
  describeAuditActor,
  formatAuditActor,
  parseAuditActor,
  type AuditActor,
} from "./audit-actor";

describe("formatAuditActor", () => {
  it("prefixes a human actor with `user:`", () => {
    expect(formatAuditActor({ kind: "user", id: "u_123" })).toBe("user:u_123");
  });

  it("prefixes a machine credential with `key:` — the thing you would ROTATE", () => {
    expect(formatAuditActor({ kind: "key", id: "k_abc" })).toBe("key:k_abc");
  });

  it("writes a genuine system action as the literal `system`, never null", () => {
    expect(formatAuditActor({ kind: "system" })).toBe("system");
  });

  // The whole point of the slice: a machine principal must not be indistinguishable from the
  // delivery DO. Before this, both wrote NULL.
  it("never collapses a key actor and a system actor onto the same value", () => {
    expect(formatAuditActor({ kind: "key", id: "k_1" })).not.toBe(
      formatAuditActor({ kind: "system" }),
    );
  });
});

describe("parseAuditActor", () => {
  it("round-trips every actor kind", () => {
    const actors: AuditActor[] = [
      { kind: "user", id: "u_1" },
      { kind: "key", id: "k_1" },
      { kind: "system" },
    ];
    for (const actor of actors) {
      expect(parseAuditActor(formatAuditActor(actor))).toEqual(actor);
    }
  });

  // Ids are opaque. Split on the FIRST colon so an id that itself contains a colon survives
  // the round-trip rather than being silently truncated to a DIFFERENT id.
  it("keeps an id that contains a colon intact", () => {
    expect(parseAuditActor("key:k:with:colons")).toEqual({ kind: "key", id: "k:with:colons" });
  });

  // Rows written before this change: a bare user id (web actions wrote the raw id) or NULL
  // (every api/mcp/cli mutation). They are IMMUTABLE and hash-chained — we cannot rewrite them,
  // so we must read them honestly rather than pretend to an attribution we never captured.
  it("reads a legacy bare id as a user actor, flagged legacy", () => {
    expect(parseAuditActor("u_legacy")).toEqual({ kind: "user", id: "u_legacy", legacy: true });
  });

  it("reads a legacy NULL as `unattributed` — NOT as a system action", () => {
    expect(parseAuditActor(null)).toEqual({ kind: "unattributed" });
  });

  it("does not mistake an unknown prefix for a known kind", () => {
    expect(parseAuditActor("robot:r_1")).toEqual({ kind: "user", id: "robot:r_1", legacy: true });
  });
});

describe("describeAuditActor", () => {
  it("labels an unattributed legacy row honestly", () => {
    expect(describeAuditActor(parseAuditActor(null))).toBe("Unattributed");
  });

  it("labels a system action", () => {
    expect(describeAuditActor({ kind: "system" })).toBe("System");
  });
});

describe("auditActorFromContext", () => {
  // The actor is the CREDENTIAL THAT AUTHENTICATED THE REQUEST. On api/mcp/cli that is the key —
  // the precise, rotatable identifier. The accountable human stays recoverable by joining
  // api_keys.created_by at READ time, which keeps the bearer hot path narrow (webhook_authn is
  // never granted created_by) and keeps the link authoritative rather than a denormalized copy.
  it("attributes an api-key request to the presenting key", () => {
    expect(auditActorFromContext({ orgId: "o1", scopes: [], keyId: "k_1" })).toEqual({
      kind: "key",
      id: "k_1",
    });
  });

  it("prefers the key over the user when a grant-minted key carries both", () => {
    expect(auditActorFromContext({ orgId: "o1", scopes: [], keyId: "k_1", userId: "u_1" })).toEqual(
      {
        kind: "key",
        id: "k_1",
      },
    );
  });

  it("attributes a session-only principal to the user", () => {
    expect(auditActorFromContext({ orgId: "o1", scopes: [], userId: "u_1" })).toEqual({
      kind: "user",
      id: "u_1",
    });
  });

  // Fails HONEST, not closed-with-a-lie: we must never stamp `system` on a request that had a
  // principal we simply failed to identify.
  it("returns unattributed — never `system` — when the context identifies neither", () => {
    expect(auditActorFromContext({ orgId: "o1", scopes: [] })).toEqual({ kind: "unattributed" });
  });
});
