// The full-chain audit verifier (§0.7, ADR-0004, H2). A pure, DB-free walker over a
// per-org set of stored audit rows that proves the chain is intact:
//   1. every row belongs to the org being verified,
//   2. seq is contiguous from the genesis (seq 1) with no gaps or duplicates,
//   3. the genesis row has a null prev_hash and every later row's prev_hash equals
//      the prior row's row_hash (the link), and
//   4. the HMAC of every row recomputes to its stored row_hash (the tamper guard).
//
// It is intentionally storage-agnostic: the db package reads the rows under RLS and
// hands them here, so the same walker is reusable from a CLI export, an API endpoint,
// the MCP surface, or the (post-freeze) WORM head-anchor cron. The HMAC key is passed
// in from the runtime binding — it is NEVER available to the DB role (ADR-0004).

import type { AuditEntry } from "./audit";
import { computeAuditRowHash } from "./audit";
import { timingSafeEqual } from "./bytes";

/** A row as stored in audit_log: the hashed entry fields plus the chain hashes. */
export interface StoredAuditRow extends AuditEntry {
  /** null only for the genesis row (seq 1). */
  readonly prevHash: Uint8Array | null;
  /** The stored HMAC tag (audit_log.row_hash). */
  readonly rowHash: Uint8Array;
}

/** The kinds of chain break the verifier can identify, in walk order. */
export type AuditBreakKind =
  | "wrong_org" // a row's org_id is not the org being verified
  | "bad_genesis_seq" // the first row's seq is not 1
  | "bad_genesis_prev_hash" // the genesis row carries a non-null prev_hash
  | "duplicate_seq" // two rows share a seq (a fork)
  | "seq_gap" // seq jumped by more than 1 (a deleted/missing row)
  | "broken_link" // prev_hash != the prior row's row_hash
  | "hash_mismatch"; // the HMAC of the row does not recompute to row_hash

export interface AuditChainBreak {
  readonly kind: AuditBreakKind;
  /** The seq of the offending row (for a seq_gap, the seq AFTER the gap). */
  readonly seq: number;
  /** A short, on-voice description for surfacing to an operator. */
  readonly detail: string;
}

export type AuditChainResult =
  | { readonly ok: true; readonly rowsVerified: number }
  | { readonly ok: false; readonly rowsVerified: number; readonly break: AuditChainBreak };

function broken(
  kind: AuditBreakKind,
  seq: number,
  detail: string,
  rowsVerified: number,
): AuditChainResult {
  return { ok: false, rowsVerified, break: { kind, seq, detail } };
}

/**
 * Walk a per-org audit chain and return the first break (kind + seq) on failure, or
 * `{ ok: true }`. Rows may arrive in any order — they are sorted by seq first. An empty
 * set is vacuously valid. The key must be the same HMAC key the chain was written with.
 */
export async function verifyAuditChain(
  key: CryptoKey,
  orgId: string,
  rows: readonly StoredAuditRow[],
): Promise<AuditChainResult> {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);

  let verified = 0;
  // The prior row's (seq, rowHash) move together — null before the genesis row, both
  // present after it. Modelling them as ONE nullable object makes that invariant visible
  // to the type system (no `prevRowHash!` non-null assertion, no way to set one without
  // the other).
  let prev: { seq: number; rowHash: Uint8Array } | null = null;

  for (const row of sorted) {
    if (row.orgId !== orgId) {
      return broken(
        "wrong_org",
        row.seq,
        `row ${row.seq} belongs to org ${row.orgId}, not ${orgId}`,
        verified,
      );
    }

    if (prev === null) {
      // Genesis row.
      if (row.seq !== 1) {
        return broken("bad_genesis_seq", row.seq, `chain must start at seq 1, got ${row.seq}`, 0);
      }
      if (row.prevHash !== null) {
        return broken(
          "bad_genesis_prev_hash",
          row.seq,
          "genesis row (seq 1) must have a null prev_hash",
          0,
        );
      }
    } else {
      if (row.seq === prev.seq) {
        return broken(
          "duplicate_seq",
          row.seq,
          `duplicate seq ${row.seq} (a forked chain)`,
          verified,
        );
      }
      if (row.seq !== prev.seq + 1) {
        return broken(
          "seq_gap",
          row.seq,
          `seq jumped from ${prev.seq} to ${row.seq} (a row is missing)`,
          verified,
        );
      }
      if (row.prevHash === null || !timingSafeEqual(row.prevHash, prev.rowHash)) {
        return broken(
          "broken_link",
          row.seq,
          `prev_hash of seq ${row.seq} does not match the prior row_hash`,
          verified,
        );
      }
    }

    const entry: AuditEntry = {
      orgId: row.orgId,
      seq: row.seq,
      actor: row.actor,
      action: row.action,
      target: row.target,
    };
    const expected = await computeAuditRowHash(key, row.prevHash, entry);
    if (!timingSafeEqual(expected, row.rowHash)) {
      return broken(
        "hash_mismatch",
        row.seq,
        `row_hash of seq ${row.seq} does not recompute (tampered or wrong key)`,
        verified,
      );
    }

    verified += 1;
    prev = { seq: row.seq, rowHash: row.rowHash };
  }

  return { ok: true, rowsVerified: verified };
}
