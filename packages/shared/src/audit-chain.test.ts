import { beforeAll, describe, expect, it } from "vitest";

import type { AuditEntry } from "./audit";
import { computeAuditRowHash, importAuditKey } from "./audit";
import { verifyAuditChain, type StoredAuditRow } from "./audit-chain";

// The full-chain walker is the post-freeze verifier (ADR-0004, H2). These are pure
// unit tests over an in-memory chain; the db package drives the same walker against a
// real Postgres in test/audit-append.test.ts.

let key: CryptoKey;
const orgId = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";

const entries: AuditEntry[] = [
  { orgId, seq: 1, actor: "user_abc", action: "org.created", target: null },
  { orgId, seq: 2, actor: "user_abc", action: "endpoint.created", target: "ep_1" },
  { orgId, seq: 3, actor: null, action: "key.rotated", target: "ep_1" },
];

/** Build a valid stored chain from the entries, linking each prev_hash forward. */
async function buildChain(es: AuditEntry[]): Promise<StoredAuditRow[]> {
  const rows: StoredAuditRow[] = [];
  let prev: Uint8Array | null = null;
  for (const entry of es) {
    const rowHash = await computeAuditRowHash(key, prev, entry);
    rows.push({ ...entry, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

beforeAll(async () => {
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 2)));
});

describe("verifyAuditChain", () => {
  it("verifies a clean, contiguous, well-linked chain", async () => {
    const rows = await buildChain(entries);
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(3);
  });

  it("verifies an empty chain (no rows is vacuously valid)", async () => {
    const result = await verifyAuditChain(key, orgId, []);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(0);
  });

  it("verifies a single genesis-only chain", async () => {
    const rows = await buildChain(entries.slice(0, 1));
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(1);
  });

  it("catches a tampered payload (HMAC no longer recomputes)", async () => {
    const rows = await buildChain(entries);
    // Edit a field after the fact without recomputing the HMAC.
    rows[1] = { ...rows[1]!, action: "endpoint.deleted" };
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("hash_mismatch");
    expect(result.break.seq).toBe(2);
  });

  it("catches a deleted row (seq gap)", async () => {
    const rows = await buildChain(entries);
    rows.splice(1, 1); // drop seq 2 -> 1, 3
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("seq_gap");
    expect(result.break.seq).toBe(3);
  });

  it("catches a forked / duplicate seq", async () => {
    const rows = await buildChain(entries);
    rows[2] = { ...rows[2]!, seq: 2 }; // duplicate seq 2
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("duplicate_seq");
    expect(result.break.seq).toBe(2);
  });

  it("catches a broken link (prev_hash does not match the prior row_hash)", async () => {
    const rows = await buildChain(entries);
    rows[2] = { ...rows[2]!, prevHash: new Uint8Array(32) };
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("broken_link");
    expect(result.break.seq).toBe(3);
  });

  it("rejects a genesis row that does not start at seq 1", async () => {
    const rows = await buildChain(entries.slice(1, 2)); // starts at seq 2
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("bad_genesis_seq");
    expect(result.break.seq).toBe(2);
  });

  it("rejects a genesis row that carries a non-null prev_hash", async () => {
    const [genesis] = entries;
    const rowHash = await computeAuditRowHash(key, null, genesis!);
    const rows: StoredAuditRow[] = [{ ...genesis!, prevHash: new Uint8Array(32), rowHash }];
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("bad_genesis_prev_hash");
    expect(result.break.seq).toBe(1);
  });

  it("rejects rows that belong to a different org (caller passed a mixed set)", async () => {
    const rows = await buildChain(entries);
    rows[1] = { ...rows[1]!, orgId: "0190a1b2-c3d4-7e5f-8a0b-ffffffffffff" };
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("wrong_org");
    expect(result.break.seq).toBe(2);
  });

  it("identifies only the FIRST break when several rows are corrupt", async () => {
    const rows = await buildChain(entries);
    rows[1] = { ...rows[1]!, action: "x" }; // break at seq 2
    rows[2] = { ...rows[2]!, action: "y" }; // also broken, but later
    const result = await verifyAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.seq).toBe(2);
  });

  it("does not require the caller to pre-sort rows (it sorts by seq)", async () => {
    const rows = await buildChain(entries);
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    const result = await verifyAuditChain(key, orgId, shuffled);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(3);
  });
});
