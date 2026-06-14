// The audit append-service library (ADR-0004). A clean, transport-agnostic
// function control-plane emitters (endpoint-created, key-rotated, replay, …)
// call to write the next tamper-evident audit row. It:
//   1. takes a per-org Postgres advisory lock (xact-scoped, auto-released on commit),
//   2. reads the current chain head (seq + row_hash) under that lock,
//   3. computes the next row_hash = HMAC(key, prev_hash || canonical(fields)), and
//   4. inserts the row.
//
// The advisory lock makes head-read + insert atomic per org, so concurrent appends
// don't race to the same seq (the DB's unique (org_id, seq) is the backstop; the lock
// avoids the retry). The HMAC key is passed in from a runtime binding — it is NEVER
// read from the DB role, so a DB-role compromise can't forge the chain (ADR-0004).
//
// Must run inside a tenant transaction (see withTenant): the advisory lock is
// xact-scoped, and the RLS GUC must already be set so the head read and insert see
// exactly this org's chain.

import { computeAuditRowHash, type AuditEntry, type StoredAuditRow } from "@webhook-co/shared";

import type { Sql, TenantTx } from "./client";

/** The caller-supplied fields for a new audit row (seq is assigned by the service). */
export interface AuditAppendInput {
  readonly orgId: string;
  /** Pseudonymous actor (Better Auth user_id), or null for system actions. */
  readonly actor: string | null;
  readonly action: string;
  readonly target: string | null;
}

/** Coerce a DB bytea (postgres.js returns a Node Buffer) to a plain Uint8Array. */
function toBytes(value: Uint8Array | null): Uint8Array | null {
  if (value === null) return null;
  // A Buffer IS a Uint8Array, but copy to a clean view so callers never depend on
  // Buffer semantics and the bytes can't be mutated underneath the chain.
  return Uint8Array.from(value);
}

/**
 * Append the next row to an org's audit chain and return the stored row. Runs inside
 * the caller's tenant transaction `tx`; takes a per-org advisory lock first so the
 * head read + insert is atomic. `key` is the audit HMAC key from the runtime binding.
 */
export async function appendAuditEntry(
  tx: TenantTx,
  key: CryptoKey,
  input: AuditAppendInput,
): Promise<StoredAuditRow> {
  // Per-org, transaction-scoped advisory lock. hashtextextended gives a stable 64-bit
  // key from the org uuid; the lock auto-releases on commit/rollback. The namespace salt
  // (passed as hashtextextended's seed) keeps this lock space from colliding with any
  // other advisory-lock user. The single-arg bigint form is used because the two-arg
  // form takes (int4, int4) and would truncate the 64-bit hash.
  await tx`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, ${AUDIT_LOCK_NAMESPACE}))`;

  const [head] = await tx<{ seq: string | number; row_hash: Uint8Array }[]>`
    select seq, row_hash from audit_log
    where org_id = ${input.orgId}
    order by seq desc
    limit 1`;

  const prevHash = head ? toBytes(head.row_hash) : null;
  const seq = head ? Number(head.seq) + 1 : 1;

  const entry: AuditEntry = {
    orgId: input.orgId,
    seq,
    actor: input.actor,
    action: input.action,
    target: input.target,
  };
  const rowHash = await computeAuditRowHash(key, prevHash, entry);

  // postgres.js sends a Uint8Array as bytea. prev_hash is null for the genesis row.
  await tx`
    insert into audit_log (org_id, seq, actor, action, target, prev_hash, row_hash)
    values (${input.orgId}, ${seq}, ${input.actor}, ${input.action}, ${input.target},
            ${prevHash}, ${rowHash})`;

  return { ...entry, prevHash, rowHash };
}

/** Distinguishes the audit advisory-lock space from any other advisory-lock user. */
const AUDIT_LOCK_NAMESPACE = 0x41554449; // "AUDI"

/**
 * Read an org's full audit chain (ascending seq) as StoredAuditRow[], ready for
 * verifyAuditChain. Runs under the caller's RLS context, so it returns exactly this
 * org's rows. For very large chains, page this — the walker is streaming-friendly.
 */
export async function readAuditChain(tx: TenantTx, orgId: string): Promise<StoredAuditRow[]> {
  const rows = await tx<
    {
      org_id: string;
      seq: string | number;
      actor: string | null;
      action: string;
      target: string | null;
      prev_hash: Uint8Array | null;
      row_hash: Uint8Array;
    }[]
  >`
    select org_id, seq, actor, action, target, prev_hash, row_hash
    from audit_log
    where org_id = ${orgId}
    order by seq asc`;

  return rows.map((r) => ({
    orgId: r.org_id,
    seq: Number(r.seq),
    actor: r.actor,
    action: r.action,
    target: r.target,
    prevHash: toBytes(r.prev_hash),
    rowHash: toBytes(r.row_hash)!,
  }));
}

/** A per-org audit-chain head: the latest (seq, row_hash) for an org. */
export interface AuditChainHead {
  readonly orgId: string;
  readonly seq: number;
  readonly rowHash: Uint8Array;
}

/**
 * Read EVERY org's current chain head (latest seq + row_hash), for the WORM head-anchor cron.
 * Runs on a webhook_anchor connection — NOT a tenant tx: that role's role-targeted SELECT policy
 * (FOR SELECT TO webhook_anchor USING (true)) grants the cross-org read, and its COLUMN grant
 * limits it to (org_id, seq, row_hash). Orgs with no audit rows have no chain to anchor and are
 * simply absent. `distinct on (org_id) ... order by org_id, seq desc` yields one head per org.
 */
export async function readAuditChainHeads(sql: Sql): Promise<AuditChainHead[]> {
  const rows = await sql<{ org_id: string; seq: string | number; row_hash: Uint8Array }[]>`
    select distinct on (org_id) org_id, seq, row_hash
    from audit_log
    order by org_id, seq desc`;
  return rows.map((r) => ({
    orgId: r.org_id,
    seq: Number(r.seq),
    rowHash: Uint8Array.from(r.row_hash),
  }));
}
