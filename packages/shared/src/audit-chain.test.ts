import { beforeAll, describe, expect, it } from "vitest";

import type { AuditEntry } from "./audit";
import { computeAuditRowHash, importAuditKey } from "./audit";
import {
  verifyAuditChain,
  verifyAuditChainChunk,
  type AuditChainCursor,
  type StoredAuditRow,
} from "./audit-chain";

// The full-chain walker is the audit verifier (ADR-0004). These are pure
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

// The chunk verifier is what makes paged verification (#636) possible: the only state crossing a page
// boundary is the prior row's (seq, rowHash), carried as the cursor. These tests inject breaks AT a chunk
// boundary — the paging-specific concern the whole-chain form never exercises.
describe("verifyAuditChainChunk (paged verification)", () => {
  const longEntries: AuditEntry[] = Array.from({ length: 5 }, (_, i) => ({
    orgId,
    seq: i + 1,
    actor: i % 2 === 0 ? "user_abc" : null,
    action: `action.${i + 1}`,
    target: i === 0 ? null : `t_${i}`,
  }));

  /** Drive verifyAuditChainChunk over `rows` in pages of `size`, carrying the tail cursor across boundaries. */
  async function verifyInPages(rows: readonly StoredAuditRow[], size: number) {
    let cursor: AuditChainCursor | null = null;
    let verified = 0;
    for (let i = 0; i < rows.length; i += size) {
      const result = await verifyAuditChainChunk(
        key,
        orgId,
        rows.slice(i, i + size),
        cursor,
        verified,
      );
      if (!result.ok) return result;
      cursor = result.tail;
      verified = result.rowsVerified;
    }
    return { ok: true as const, rowsVerified: verified };
  }

  it("verifies a clean chain identically to the whole-chain form, across page boundaries", async () => {
    const rows = await buildChain(longEntries);
    const whole = await verifyAuditChain(key, orgId, rows);
    // Page sizes that DON'T divide 5 evenly force a boundary between every check position.
    for (const size of [1, 2, 3, 5]) {
      const paged = await verifyInPages(rows, size);
      expect(paged).toEqual(whole); // same ok + same rowsVerified (5)
    }
  });

  it("catches a broken LINK at a page boundary (the first row of a later page)", async () => {
    const rows = await buildChain(longEntries);
    // Corrupt seq 3's prev_hash — with pageSize 2 it is the FIRST row of the 2nd page, so the link check
    // must use the carried cursor (page 1's tail), not a same-page prior row.
    const corrupt = rows.map((r) => (r.seq === 3 ? { ...r, prevHash: new Uint8Array(32) } : r));
    const result = await verifyInPages(corrupt, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("broken_link");
    expect(result.break.seq).toBe(3);
    expect(result.rowsVerified).toBe(2); // seqs 1 + 2 verified before the boundary break
  });

  it("catches a seq GAP straddling a page boundary", async () => {
    const rows = await buildChain(longEntries);
    // Drop seq 3, so page 1 = [1,2] and page 2 starts at seq 4 — the gap is exactly at the boundary.
    const withGap = rows.filter((r) => r.seq !== 3);
    const result = await verifyInPages(withGap, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("seq_gap");
    expect(result.break.seq).toBe(4);
  });
});
