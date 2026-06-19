import { canonicalizeAuditEntry, importAuditKey } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  canonicalizeAuthAuditEntry,
  computeAuthAuditRowHash,
  verifyAuthAuditRowHash,
  type AuthAuditEntry,
} from "./auth-audit";

// Pure (no DB) coverage for the `aae1` control-plane audit canon — a SEPARATE chain from
// audit_log's frozen `wha1` (packages/shared). aae1 hashes ALL the auth fields
// (org/seq/actor/event_type/target_id/ip/geo/metadata) with sorted-key canonical JSON for the
// jsonb columns, length-prefixed so no value can be confused with a delimiter, and a distinct
// version prefix so the two chains can safely share the audit HMAC key (domain separation).

const ORG = "11111111-1111-7111-8111-111111111111";
const td = new TextDecoder();

function entry(over: Partial<AuthAuditEntry> = {}): AuthAuditEntry {
  return {
    orgId: ORG,
    seq: 1,
    actor: "user_1",
    eventType: "key_minted",
    targetId: "key_abc",
    ip: null,
    geo: null,
    metadata: null,
    ...over,
  };
}

describe("canonicalizeAuthAuditEntry — the aae1 canon", () => {
  it("is deterministic for identical input", () => {
    expect(canonicalizeAuthAuditEntry(entry())).toEqual(canonicalizeAuthAuditEntry(entry()));
  });

  it("carries the aae1 version prefix (domain-separates from audit_log's wha1)", () => {
    expect(td.decode(canonicalizeAuthAuditEntry(entry())).startsWith("aae1|")).toBe(true);
  });

  it("sorts jsonb keys so geo/metadata key order does not change the hash", () => {
    const a = entry({ geo: { country: "US", region: "CA" }, metadata: { a: 1, b: 2 } });
    const b = entry({ geo: { region: "CA", country: "US" }, metadata: { b: 2, a: 1 } });
    expect(canonicalizeAuthAuditEntry(a)).toEqual(canonicalizeAuthAuditEntry(b));
  });

  it("sorts NESTED jsonb keys (deep canonicalization)", () => {
    const a = entry({ metadata: { outer: { x: 1, y: 2 }, z: 3 } });
    const b = entry({ metadata: { z: 3, outer: { y: 2, x: 1 } } });
    expect(canonicalizeAuthAuditEntry(a)).toEqual(canonicalizeAuthAuditEntry(b));
  });

  it("preserves array element ORDER in jsonb (only object keys are sorted)", () => {
    const a = entry({ metadata: { scopes: ["events:read", "events:replay"] } });
    const b = entry({ metadata: { scopes: ["events:replay", "events:read"] } });
    expect(canonicalizeAuthAuditEntry(a)).not.toEqual(canonicalizeAuthAuditEntry(b));
  });

  it("distinguishes null geo/metadata from an empty object", () => {
    expect(canonicalizeAuthAuditEntry(entry({ metadata: null }))).not.toEqual(
      canonicalizeAuthAuditEntry(entry({ metadata: {} })),
    );
  });

  it("length-prefixes fields so a delimiter cannot be smuggled across a boundary", () => {
    // Naive concat would let actor="a" + target="b" collide with actor="a:b" + target="".
    // The byte-length prefix makes the two canons distinct.
    const split = canonicalizeAuthAuditEntry(entry({ actor: "a", targetId: "b" }));
    const merged = canonicalizeAuthAuditEntry(entry({ actor: "a:b", targetId: "" }));
    expect(split).not.toEqual(merged);
  });

  it("distinguishes a null field from the empty string", () => {
    expect(canonicalizeAuthAuditEntry(entry({ targetId: null }))).not.toEqual(
      canonicalizeAuthAuditEntry(entry({ targetId: "" })),
    );
  });

  it("changes when any hashed field changes (event_type)", () => {
    expect(canonicalizeAuthAuditEntry(entry({ eventType: "key_minted" }))).not.toEqual(
      canonicalizeAuthAuditEntry(entry({ eventType: "key_revoked" })),
    );
  });
});

describe("aae1 / wha1 domain separation", () => {
  it("the frozen wha1 canon is byte-for-byte unchanged (golden regression)", () => {
    // If this ever changes, the audit_log chain (packages/shared) was altered — STOP.
    const golden =
      "wha1|" +
      "36:11111111-1111-7111-8111-111111111111" +
      "1:1" +
      "6:user_1" +
      "11:org.created" +
      "_:";
    const bytes = canonicalizeAuditEntry({
      orgId: ORG,
      seq: 1,
      actor: "user_1",
      action: "org.created",
      target: null,
    });
    expect(td.decode(bytes)).toBe(golden);
  });

  it("never produces wha1 bytes (the prefix alone forks the two chains)", () => {
    expect(td.decode(canonicalizeAuthAuditEntry(entry())).startsWith("wha1")).toBe(false);
  });
});

describe("computeAuthAuditRowHash / verifyAuthAuditRowHash", () => {
  it("recomputes to the same 32-byte tag and verifies (constant-time)", async () => {
    const key = await importAuditKey(new Uint8Array(32).fill(0x5a));
    const e = entry({ ip: "203.0.113.7", geo: { country: "US" } });
    const hash = await computeAuthAuditRowHash(key, null, e);
    expect(hash.length).toBe(32);
    expect(await verifyAuthAuditRowHash(key, null, e, hash)).toBe(true);
  });

  it("chains: the prev_hash prefix changes the row_hash", async () => {
    const key = await importAuditKey(new Uint8Array(32).fill(0x5a));
    const e = entry({ seq: 2 });
    const genesisHash = await computeAuthAuditRowHash(key, null, entry());
    const withPrev = await computeAuthAuditRowHash(key, genesisHash, e);
    const withoutPrev = await computeAuthAuditRowHash(key, null, e);
    expect(withPrev).not.toEqual(withoutPrev);
  });

  it("rejects a tampered entry (verify fails when a field is altered)", async () => {
    const key = await importAuditKey(new Uint8Array(32).fill(0x5a));
    const e = entry();
    const hash = await computeAuthAuditRowHash(key, null, e);
    expect(await verifyAuthAuditRowHash(key, null, { ...e, targetId: "key_xyz" }, hash)).toBe(
      false,
    );
  });
});

describe("canon hardening — fail-loud + total over its input", () => {
  it("throws on a non-finite number anywhere in jsonb (never silently bricks the chain)", () => {
    // A top-level NaN/Infinity would JSON.stringify to "null" at hash time but store as jsonb null,
    // so readback would recompute a different hash — a silent false-tamper. Reject it at write.
    expect(() => canonicalizeAuthAuditEntry(entry({ metadata: { n: Number.NaN } }))).toThrow(
      /finite/i,
    );
    expect(() => canonicalizeAuthAuditEntry(entry({ geo: Number.POSITIVE_INFINITY }))).toThrow(
      /finite/i,
    );
  });

  it("hashes a __proto__ jsonb key as ordinary data (Object.create(null), no proto manipulation)", () => {
    // JSON.parse makes __proto__ an OWN key; the canon must cover it, not drop it via the prototype
    // setter. Two metadata objects differing only in __proto__ content must differ in the canon.
    const a = entry({ metadata: JSON.parse('{"__proto__":"x"}') as unknown });
    const b = entry({ metadata: JSON.parse('{"__proto__":"y"}') as unknown });
    expect(canonicalizeAuthAuditEntry(a)).not.toEqual(canonicalizeAuthAuditEntry(b));
  });

  it("does not pollute Object.prototype while canonicalizing a hostile __proto__ payload", () => {
    canonicalizeAuthAuditEntry(
      entry({ metadata: JSON.parse('{"__proto__":{"polluted":true}}') as unknown }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
