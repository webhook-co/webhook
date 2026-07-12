// Batched audit-chain seeder — TEST FIXTURE ONLY (no production caller: the app appends one
// audited action at a time, and appendAuditEntry is the only path that may do so).
//
// WHY THIS EXISTS. Several limiters (event deletes, ingest-url reveals) count audit rows inside a
// 60s WALL-CLOCK window. To prove a limiter trips, a test must first put cap-many rows inside that
// window. Driving that through appendAuditEntry costs 3 round-trips per row (advisory lock, head
// read, insert) — and every row is stamped `created_at := now()`, the TRANSACTION timestamp. So on
// a remote Postgres (the nightly Neon branch) a 300-row seed loop runs for longer than the window
// it is trying to fill: the transaction's now() is already >60s in the past by the time the limiter
// looks, every seeded row is born expired, the limiter does not trip, and the test FALSE-PASSES
// (resolves instead of rejecting). That is issue #383, and the same class as #413's reveal limiter.
//
// This seeder writes the SAME chain — same HMAC, same links, same trigger validation — in ONE
// insert, so the seed is over in a single round-trip and the window it fills is real. The chain is
// computed client-side, which is sound because computeAuditRowHash covers (prev_hash, org, seq,
// actor, action, target) and NOT created_at: the server stamps the time, the client owns the links.

import { computeAuditRowHash, formatAuditActor, type StoredAuditRow } from "@webhook-co/shared";

import type { AuditAppendInput } from "../src/audit-append";
import type { TenantTx } from "../src/client";

/** The chain head to continue from: the org's latest (seq, row_hash), or null for a fresh chain. */
export interface AuditChainHeadRef {
  readonly seq: number;
  readonly rowHash: Uint8Array;
}

/**
 * Build `count` consecutive audit rows for one org, linked into a valid chain starting after `head`.
 * Pure: no DB, no clock — the caller pays zero round-trips for the hashing.
 */
export async function buildAuditChainRows(
  key: CryptoKey,
  input: AuditAppendInput,
  count: number,
  head: AuditChainHeadRef | null,
): Promise<StoredAuditRow[]> {
  const actor = formatAuditActor(input.actor);
  const rows: StoredAuditRow[] = [];
  let prevHash: Uint8Array | null = head ? head.rowHash : null;
  let seq = head ? head.seq + 1 : 1;

  for (let i = 0; i < count; i++) {
    const entry = {
      orgId: input.orgId,
      seq,
      actor,
      action: input.action,
      target: input.target,
    };
    const rowHash = await computeAuditRowHash(key, prevHash, entry);
    rows.push({ ...entry, prevHash, rowHash });
    prevHash = rowHash;
    seq += 1;
  }
  return rows;
}

/**
 * Seed `count` audit rows for `input.orgId` in ONE insert and return them. Runs inside the caller's
 * tenant transaction, exactly like appendAuditEntry: the RLS GUC must already be set, so the head
 * read and the insert both see (and are policed to) this org's chain.
 *
 * The per-row BEFORE INSERT trigger (audit_log_chain) still validates every row's seq contiguity
 * and prev_hash linkage — a multi-row insert does not get to skip it — so a bad chain is rejected
 * by the database, not merely by the tests.
 */
export async function seedAuditChain(
  tx: TenantTx,
  key: CryptoKey,
  input: AuditAppendInput,
  count: number,
): Promise<StoredAuditRow[]> {
  const [head] = await tx<{ seq: string | number; row_hash: Uint8Array }[]>`
    select seq, row_hash from audit_log
    where org_id = ${input.orgId}
    order by seq desc
    limit 1`;

  const rows = await buildAuditChainRows(
    key,
    input,
    count,
    head ? { seq: Number(head.seq), rowHash: Uint8Array.from(head.row_hash) } : null,
  );
  if (rows.length === 0) return rows;

  await tx`insert into audit_log ${tx(
    rows.map((r) => ({
      org_id: r.orgId,
      seq: r.seq,
      actor: r.actor,
      action: r.action,
      target: r.target,
      prev_hash: r.prevHash,
      row_hash: r.rowHash,
    })),
    "org_id",
    "seq",
    "actor",
    "action",
    "target",
    "prev_hash",
    "row_hash",
  )}`;

  return rows;
}
