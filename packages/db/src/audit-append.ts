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

import {
  computeAuditRowHash,
  formatAuditActor,
  verifyAuditChainChunk,
  type AuditActor,
  type AuditChainCursor,
  type AuditChainResult,
  type AuditEntry,
  type StoredAuditRow,
} from "@webhook-co/shared";

import type { Sql, TenantTx } from "./client";

/** The caller-supplied fields for a new audit row (seq is assigned by the service). */
export interface AuditAppendInput {
  readonly orgId: string;
  /**
   * WHO acted — a typed actor, not a bare id.
   *
   * This is deliberately NOT `string | null`. It used to be, and the result was that every write handler on
   * api/mcp/cli passed `ctx.userId ?? null` — which is always null for a standalone api key — so every
   * mutation over those surfaces was recorded as NULL, indistinguishable from the delivery DO's genuine
   * system actions. Taking the typed union makes that class of mistake UNREPRESENTABLE: a caller cannot pass
   * a raw id, and cannot omit the choice between a user, a key, and the system. The compiler enumerates
   * every mint site, so a NEW audited path cannot be added without declaring whose action it records.
   *
   * `unattributed` is not accepted: it exists only to READ rows written before this vocabulary. A new row
   * must always name its actor.
   */
  readonly actor: Exclude<AuditActor, { kind: "unattributed" }>;
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

  // The stored (and therefore HASHED) form. A prefixed string is still a string, so the frozen `wha1` canon
  // and every previously-written row verify unchanged — attribution gets stronger with no chain break.
  const actor = formatAuditActor(input.actor);
  const entry: AuditEntry = {
    orgId: input.orgId,
    seq,
    actor,
    action: input.action,
    target: input.target,
  };
  const rowHash = await computeAuditRowHash(key, prevHash, entry);

  // postgres.js sends a Uint8Array as bytea. prev_hash is null for the genesis row.
  await tx`
    insert into audit_log (org_id, seq, actor, action, target, prev_hash, row_hash)
    values (${input.orgId}, ${seq}, ${actor}, ${input.action}, ${input.target},
            ${prevHash}, ${rowHash})`;

  return { ...entry, prevHash, rowHash };
}

/** Distinguishes the audit advisory-lock space from any other advisory-lock user. Exported so any
 *  other writer to this chain (today: the tests' batched window seeder) takes the SAME lock — a
 *  second lock space would not serialize against this one, which is the whole point of the lock. */
export const AUDIT_LOCK_NAMESPACE = 0x41554449; // "AUDI"

export interface AuditListEntry {
  /** The per-org monotonic sequence — also the keyset cursor. */
  readonly seq: number;
  /** Dot-namespaced and OPEN (new actions ship without a schema change) — render it, don't switch on it. */
  readonly action: string;
  readonly target: string | null;
  /** Prefixed actor (`user:<id>` / `key:<id>` / `system`), or null on a legacy pre-attribution row. */
  readonly actor: string | null;
  readonly createdAt: Date;
}

export interface AuditListPage {
  readonly items: AuditListEntry[];
  /** Pass back as `afterSeq` for the next page; null when the chain is exhausted. */
  readonly nextSeq: number | null;
}

/**
 * List an org's audit entries, newest first, for the dashboard (Lane 2.8).
 *
 * The keyset is `seq` — a per-org monotonic bigint with a `unique (org_id, seq)` index (migration 0005), so
 * this is index-served and needs no new index. It deliberately does NOT use the shared ISO-µs `Cursor`: that
 * type requires a UUID id, and audit_log's id is a bigserial. A single monotonic integer is a strictly better
 * keyset here — and it can't skip or duplicate a row, which for an audit list is the whole point.
 *
 * Runs under the caller's RLS context (withTenant), so it returns exactly this org's rows. Reading the chain
 * is an ADMINISTRATIVE act — the caller must gate on owner/admin (see isAuditReaderRole), matching the mint
 * ceiling, which already refuses a member an `audit:read` key.
 */
export async function listAuditEntries(
  tx: TenantTx,
  input: { afterSeq?: number | null; limit: number },
): Promise<AuditListPage> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const after = input.afterSeq ?? null;

  const rows = await tx<
    {
      seq: string | number;
      action: string;
      target: string | null;
      actor: string | null;
      created_at: Date;
    }[]
  >`
    select seq, action, target, actor, created_at
      from audit_log
     ${after === null ? tx`` : tx`where seq < ${after}`}
     order by seq desc
     limit ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((r) => ({
    seq: Number(r.seq),
    action: r.action,
    target: r.target,
    actor: r.actor,
    createdAt: r.created_at,
  }));
  return { items, nextSeq: hasMore ? (items[items.length - 1]?.seq ?? null) : null };
}

interface AuditRowShape {
  org_id: string;
  seq: string | number;
  actor: string | null;
  action: string;
  target: string | null;
  prev_hash: Uint8Array | null;
  row_hash: Uint8Array;
}

const toStoredRow = (r: AuditRowShape): StoredAuditRow => ({
  orgId: r.org_id,
  seq: Number(r.seq),
  actor: r.actor,
  action: r.action,
  target: r.target,
  prevHash: toBytes(r.prev_hash),
  rowHash: toBytes(r.row_hash)!,
});

/**
 * Read an org's full audit chain (ascending seq) as StoredAuditRow[], ready for verifyAuditChain. Runs under
 * the caller's RLS context, so it returns exactly this org's rows. UNBOUNDED — the whole chain in memory; for
 * verification prefer {@link verifyAuditChainPaged}, which streams it a page at a time (#636).
 */
export async function readAuditChain(tx: TenantTx, orgId: string): Promise<StoredAuditRow[]> {
  const rows = await tx<AuditRowShape[]>`
    select org_id, seq, actor, action, target, prev_hash, row_hash
    from audit_log
    where org_id = ${orgId}
    order by seq asc`;
  return rows.map(toStoredRow);
}

/** One ascending-seq page of an org's audit chain: rows with `seq > afterSeq`, capped at `limit`. Backed by
 *  the `unique (org_id, seq)` index, so each page is an index range read, not a scan. */
export async function readAuditChainPage(
  tx: TenantTx,
  orgId: string,
  afterSeq: number,
  limit: number,
): Promise<StoredAuditRow[]> {
  const rows = await tx<AuditRowShape[]>`
    select org_id, seq, actor, action, target, prev_hash, row_hash
    from audit_log
    where org_id = ${orgId} and seq > ${afterSeq}
    order by seq asc
    limit ${limit}`;
  return rows.map(toStoredRow);
}

/** How many audit rows to hold in memory per verification page. Bounds the Worker's peak memory independent
 *  of chain length (#636); the `unique (org_id, seq)` index makes each page a cheap range read. */
export const AUDIT_CHAIN_PAGE_SIZE = 1000;

/**
 * Verify an org's whole audit chain WITHOUT materialising it — read it a page at a time and walk each page
 * with {@link verifyAuditChainChunk}, carrying the prior page's tail cursor across the boundary so every
 * check (seq contiguity, prev_hash link, HMAC) holds exactly as the whole-chain form does. Fixes #636:
 * `readAuditChain` returned the ENTIRE chain, an unbounded result set that grows with org age — a Worker OOM
 * risk. Runs under the caller's RLS context (this org's rows only). Returns the same AuditChainResult, with
 * the first break's cumulative `rowsVerified`.
 */
export async function verifyAuditChainPaged(
  tx: TenantTx,
  orgId: string,
  key: CryptoKey,
  pageSize: number = AUDIT_CHAIN_PAGE_SIZE,
): Promise<AuditChainResult> {
  let cursor: AuditChainCursor | null = null;
  let afterSeq = 0;
  let verified = 0;
  for (;;) {
    const page = await readAuditChainPage(tx, orgId, afterSeq, pageSize);
    if (page.length === 0) break;
    const result = await verifyAuditChainChunk(key, orgId, page, cursor, verified);
    if (!result.ok) return result;
    cursor = result.tail;
    verified = result.rowsVerified;
    afterSeq = page[page.length - 1]!.seq;
    if (page.length < pageSize) break; // a short page is the tail of the chain
  }
  return { ok: true, rowsVerified: verified };
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
