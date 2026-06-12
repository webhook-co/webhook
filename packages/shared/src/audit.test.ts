import { beforeAll, describe, expect, it } from "vitest";

import {
  AuditEntrySchema,
  canonicalizeAuditEntry,
  computeAuditRowHash,
  importAuditKey,
  verifyAuditRowHash,
  type AuditEntry,
} from "./audit";

let key: CryptoKey;

const orgId = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const genesis: AuditEntry = {
  orgId,
  seq: 1,
  actor: "user_abc",
  action: "org.created",
  target: null,
};

beforeAll(async () => {
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 2)));
});

describe("audit canonical serialization", () => {
  it("is deterministic for the same fields", () => {
    expect([...canonicalizeAuditEntry(genesis)]).toEqual([
      ...canonicalizeAuditEntry({ ...genesis }),
    ]);
  });

  it("is unambiguous across field boundaries (length-prefixed)", () => {
    const a = canonicalizeAuditEntry({ ...genesis, action: "a", target: "bc" });
    const b = canonicalizeAuditEntry({ ...genesis, action: "ab", target: "c" });
    expect([...a]).not.toEqual([...b]);
  });

  it("validates entries with AuditEntrySchema", () => {
    expect(AuditEntrySchema.parse(genesis)).toEqual(genesis);
    expect(() => AuditEntrySchema.parse({ ...genesis, action: "" })).toThrow();
  });
});

describe("audit hash chain", () => {
  it("computes a verifiable genesis row (null prev_hash)", async () => {
    const row = await computeAuditRowHash(key, null, genesis);
    expect(row.length).toBe(32);
    expect(await verifyAuditRowHash(key, null, genesis, row)).toBe(true);
  });

  it("links seq 2 to the prior row_hash", async () => {
    const g = await computeAuditRowHash(key, null, genesis);
    const second: AuditEntry = {
      orgId,
      seq: 2,
      actor: "user_abc",
      action: "endpoint.created",
      target: "ep_1",
    };
    const row2 = await computeAuditRowHash(key, g, second);
    expect(await verifyAuditRowHash(key, g, second, row2)).toBe(true);
  });

  it("detects a tampered field (hash no longer verifies)", async () => {
    const row = await computeAuditRowHash(key, null, genesis);
    const tampered: AuditEntry = { ...genesis, action: "org.deleted" };
    expect(await verifyAuditRowHash(key, null, tampered, row)).toBe(false);
  });

  it("detects a broken link (wrong prev_hash)", async () => {
    const g = await computeAuditRowHash(key, null, genesis);
    const second: AuditEntry = { orgId, seq: 2, actor: null, action: "key.rotated", target: null };
    const row2 = await computeAuditRowHash(key, g, second);
    const wrongPrev = new Uint8Array(32);
    expect(await verifyAuditRowHash(key, wrongPrev, second, row2)).toBe(false);
  });
});
