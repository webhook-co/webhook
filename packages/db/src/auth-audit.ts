// The control-plane auth-audit chain (`aae1`), Lane B A0c. A SEPARATE tamper-evident chain from
// audit_log's frozen `wha1` (packages/shared): the control plane warrants its own field vocabulary
// (event_type / target_id / ip / geo / metadata) and its own canon version, so the audit_log chain
// stays byte-for-byte untouched (ADR-0019, ADR-0020). It mirrors audit-append.ts's discipline:
//   1. a per-org, transaction-scoped advisory lock (head-read + insert atomic per org),
//   2. read the current chain head (seq + row_hash) under that lock,
//   3. row_hash = HMAC(key, prev_hash || canonical(fields)), and
//   4. insert the row.
// The HMAC key is the SAME audit key (passed from a runtime binding, NEVER read from the DB role —
// ADR-0004); the `aae1` version prefix domain-separates the two chains so sharing the key is safe.
//
// The DB enforces chain STRUCTURE (contiguous per-org seq, prev_hash linkage, immutability — see
// migration 0013); the app supplies row_hash. Must run inside a tenant transaction (withTenant): the
// advisory lock is xact-scoped and the RLS GUC must be set so the head-read + insert see this org.

import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

import type { AuditBreakKind } from "@webhook-co/shared";

import { withTenant, type Sql, type TenantTx } from "./client";

/** The `aae1` canon version — domain-separates this chain from audit_log's `wha1`. */
const CANON_VERSION = "aae1";

/** The closed event vocabulary (mirrors the auth_audit_event CHECK constraint, migration 0013). */
export type AuthAuditEventType =
  | "login"
  | "grant_created"
  | "grant_approved"
  | "grant_revoked"
  | "key_minted"
  | "key_revoked"
  | "policy_changed"
  | "reauth"
  | "invite_created"
  | "invite_accepted"
  | "invite_revoked"
  | "member_role_changed"
  | "member_removed"
  | "org_created"
  | "org_renamed"
  // A user changed their account email — a security-relevant identity event, written to the user's
  // personal-org chain (migration 0080 widens the CHECK to match this union).
  | "email_changed";

/** The hashed control-plane audit fields. seq is the per-org monotonic sequence. */
export interface AuthAuditEntry {
  readonly orgId: string;
  readonly seq: number;
  /** Pseudonymous actor (Better Auth user_id) or "system"/null; never raw PII. */
  readonly actor: string | null;
  readonly eventType: AuthAuditEventType;
  readonly targetId: string | null;
  /** Source IP as a string (stored inet), or null. */
  readonly ip: string | null;
  /** jsonb geo — sorted-key canonicalized into the hash. JSON-roundtrippable values only. */
  readonly geo: unknown;
  /** jsonb metadata — sorted-key canonicalized into the hash. JSON-roundtrippable values only. */
  readonly metadata: unknown;
}

/** The caller-supplied fields for a new auth-audit row (seq is assigned by the service). */
export interface AuthAuditAppendInput {
  readonly orgId: string;
  readonly actor: string | null;
  readonly eventType: AuthAuditEventType;
  readonly targetId?: string | null;
  readonly ip?: string | null;
  readonly geo?: unknown;
  readonly metadata?: unknown;
}

/** A stored auth-audit row: the hashed entry plus its chain links. */
export interface StoredAuthAuditRow extends AuthAuditEntry {
  readonly prevHash: Uint8Array | null;
  readonly rowHash: Uint8Array;
}

const utf8 = new TextEncoder();

/** Length-prefixed so no field value can be confused with a delimiter. */
function segment(value: string | null): string {
  if (value === null) return "_:";
  return `${utf8.encode(value).length}:${value}`;
}

/**
 * Deterministic, sorted-key JSON for a jsonb field. Object keys are sorted recursively (so jsonb's
 * unordered storage round-trips to the same canon at verify time); array element order is preserved.
 * Returns null for null/undefined (rendered as the null segment, distinct from "{}").
 *
 * FAIL-LOUD on out-of-contract input: a non-finite number (NaN/Infinity) would JSON.stringify to
 * "null" here but store as a jsonb null, so readback would recompute a different hash — a SILENT
 * false-tamper that voids the chain. We throw instead, so a buggy emitter fails at write, never
 * bricking an org's chain. Values must be JSON-roundtrippable (strings/booleans/finite numbers/
 * nested objects/arrays); floats that lose precision through the jsonb round-trip remain out of
 * contract for v1 (acceptable: geo/metadata hold country codes, scope arrays, small string maps).
 */
function jsonField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("auth-audit: geo/metadata numbers must be finite (no NaN/Infinity)");
  }
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    // Object.create(null): no prototype, so a `__proto__` own key (which JSON.parse produces) is a
    // normal own property here — hashed as ordinary data — instead of hitting Object.prototype's
    // __proto__ setter (which would drop it from the canon AND manipulate the new object's prototype).
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Deterministic byte serialization of the hashed auth-audit fields (`aae1`). */
export function canonicalizeAuthAuditEntry(entry: AuthAuditEntry): Uint8Array {
  const canon =
    `${CANON_VERSION}|` +
    segment(entry.orgId) +
    segment(String(entry.seq)) +
    segment(entry.actor) +
    segment(entry.eventType) +
    segment(entry.targetId) +
    segment(entry.ip) +
    segment(jsonField(entry.geo)) +
    segment(jsonField(entry.metadata));
  return utf8.encode(canon);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * row_hash = HMAC(key, prev_hash || canonical(entry)). prevHash is null for the genesis row (seq 1).
 * Returns the full 32-byte tag stored as auth_audit_event.row_hash.
 */
export async function computeAuthAuditRowHash(
  key: CryptoKey,
  prevHash: Uint8Array | null,
  entry: AuthAuditEntry,
): Promise<Uint8Array> {
  const input = concat(prevHash ?? new Uint8Array(0), canonicalizeAuthAuditEntry(entry));
  // `as Uint8Array<ArrayBuffer>`: `concat` returns a freshly-allocated array (ArrayBuffer-backed at
  // runtime), but TS widens its buffer to ArrayBufferLike, which WebCrypto's BufferSource param
  // (ArrayBuffer-backed only, TS 5.7+) rejects. The narrowing cast bridges the db node-libs vs
  // DOM-WebCrypto friction; this is the only crypto.subtle call in packages/db (shared owns the rest
  // under its Worker lib config). See the tsconfig-boundary follow-up.
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input as Uint8Array<ArrayBuffer>));
}

/** Recompute and compare a row's hash (constant-time) — the verifier's per-row step. */
export async function verifyAuthAuditRowHash(
  key: CryptoKey,
  prevHash: Uint8Array | null,
  entry: AuthAuditEntry,
  expectedRowHash: Uint8Array,
): Promise<boolean> {
  const computed = await computeAuthAuditRowHash(key, prevHash, entry);
  if (computed.length !== expectedRowHash.length) return false;
  return nodeTimingSafeEqual(computed, expectedRowHash);
}

// ---- The chain WALKER (Lane 2.10) ------------------------------------------------------------------
//
// `aae1` had only a per-ROW verifier (verifyAuthAuditRowHash) — enough to check one entry in isolation, and
// useless against the attacks a chain exists to detect: a DELETED row leaves a seq gap, a REWRITTEN history
// leaves a broken link, a FORKED chain leaves a duplicate seq. None of those are visible one row at a time.
//
// This mirrors `wha1`'s walker (packages/shared/audit-chain.ts) deliberately, down to the break vocabulary:
// two tamper-evident chains that reported failure in two different dialects would be two things to learn,
// and the UI would have to special-case each. Same kinds, same operator-readable `detail`.

/** Reuses wha1's break vocabulary — one dialect for both chains. */
export type AuthAuditChainResult =
  | { readonly ok: true; readonly rowsVerified: number }
  | {
      readonly ok: false;
      readonly rowsVerified: number;
      readonly break: {
        readonly kind: AuditBreakKind;
        readonly seq: number;
        readonly detail: string;
      };
    };

/** The failure variant, shared by AuthAuditChainResult and AuthAuditChunkResult (so `authBroken` fits both). */
type AuthAuditChainBroken = Extract<AuthAuditChainResult, { ok: false }>;

function authBroken(
  kind: AuditBreakKind,
  seq: number,
  detail: string,
  rowsVerified: number,
): AuthAuditChainBroken {
  return { ok: false, rowsVerified, break: { kind, seq, detail } };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(a, b);
}

/**
 * A verification position: the last verified row's (seq, rowHash), carried between chunks. Mirrors wha1's
 * {@link import("@webhook-co/shared").AuditChainCursor} — the ONLY state that must cross a page boundary.
 */
export interface AuthAuditChainCursor {
  readonly seq: number;
  readonly rowHash: Uint8Array;
}

/** The result of verifying ONE chunk: on success, the cumulative count + the tail cursor to resume from. */
export type AuthAuditChunkResult =
  | { readonly ok: true; readonly rowsVerified: number; readonly tail: AuthAuditChainCursor | null }
  | (AuthAuditChainResult & { readonly ok: false });

/**
 * Verify ONE contiguous chunk of an org's `aae1` chain, resuming from `prior` (the previous chunk's tail
 * cursor, or null for the first chunk / genesis). This is what lets the chain be verified PAGE BY PAGE without
 * materialising the whole thing (#663): the only state that crosses a page boundary is the prior row's (seq,
 * rowHash), which `prior`/`tail` carry — so the seq-contiguity and prev_hash-link checks hold across pages
 * exactly as they do within one. Rows within the chunk may arrive in any order (sorted by seq first); the
 * caller must feed chunks in ascending seq order. `priorVerified` is the running count so a mid-chunk break
 * reports the true cumulative `rowsVerified`. Mirrors wha1's verifyAuditChainChunk (packages/shared).
 */
export async function verifyAuthAuditChainChunk(
  key: CryptoKey,
  orgId: string,
  rows: readonly StoredAuthAuditRow[],
  prior: AuthAuditChainCursor | null,
  priorVerified: number,
): Promise<AuthAuditChunkResult> {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);

  let verified = priorVerified;
  // seq + rowHash move together (null before genesis, both present after), so they are ONE nullable object —
  // the type system then rules out setting one without the other. Seeded from `prior` so a continuation
  // chunk's first row is checked as a link, not a genesis.
  let prev: AuthAuditChainCursor | null = prior;

  for (const row of sorted) {
    if (row.orgId !== orgId) {
      return authBroken(
        "wrong_org",
        row.seq,
        `row ${row.seq} belongs to org ${row.orgId}, not ${orgId}`,
        verified,
      );
    }

    if (prev === null) {
      if (row.seq !== 1) {
        return authBroken(
          "bad_genesis_seq",
          row.seq,
          `chain must start at seq 1, got ${row.seq}`,
          0,
        );
      }
      if (row.prevHash !== null) {
        return authBroken(
          "bad_genesis_prev_hash",
          row.seq,
          "genesis row (seq 1) must have a null prev_hash",
          0,
        );
      }
    } else {
      if (row.seq === prev.seq) {
        return authBroken(
          "duplicate_seq",
          row.seq,
          `duplicate seq ${row.seq} (a forked chain)`,
          verified,
        );
      }
      if (row.seq !== prev.seq + 1) {
        return authBroken(
          "seq_gap",
          row.seq,
          `seq jumped from ${prev.seq} to ${row.seq} (a row is missing)`,
          verified,
        );
      }
      if (row.prevHash === null || !bytesEqual(row.prevHash, prev.rowHash)) {
        return authBroken(
          "broken_link",
          row.seq,
          `prev_hash of seq ${row.seq} does not match the prior row_hash`,
          verified,
        );
      }
    }

    const expected = await computeAuthAuditRowHash(key, row.prevHash, row);
    if (!bytesEqual(expected, row.rowHash)) {
      return authBroken(
        "hash_mismatch",
        row.seq,
        `row ${row.seq} does not recompute to its stored hash`,
        verified,
      );
    }

    verified += 1;
    prev = { seq: row.seq, rowHash: row.rowHash };
  }

  return { ok: true, rowsVerified: verified, tail: prev };
}

/**
 * Walk an org's `aae1` chain and return the FIRST break, or `{ ok: true }`. Rows may arrive in any order —
 * they are sorted by seq first. An empty chain is vacuously valid. The key must be the one the chain was
 * written with. This is the whole-chain form (all rows in memory); for a large chain, verify it page-by-page
 * with {@link verifyAuthAuditChainPaged}, which walks it with {@link verifyAuthAuditChainChunk}.
 */
export async function verifyAuthAuditChain(
  key: CryptoKey,
  orgId: string,
  rows: readonly StoredAuthAuditRow[],
): Promise<AuthAuditChainResult> {
  const result = await verifyAuthAuditChainChunk(key, orgId, rows, null, 0);
  return result.ok ? { ok: true, rowsVerified: result.rowsVerified } : result;
}

export interface AuthAuditListEntry {
  readonly seq: number;
  readonly eventType: AuthAuditEventType;
  readonly actor: string | null;
  readonly targetId: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

export interface AuthAuditListPage {
  readonly items: AuthAuditListEntry[];
  readonly nextSeq: number | null;
}

/**
 * List an org's auth-audit entries, newest first (Lane 2.10). Keyset on `seq` — the per-org monotonic bigint
 * with a unique index — so paging can neither skip nor duplicate a row. Index-served; no migration.
 *
 * Deliberately does NOT return `ip`/`geo`: they are hashed into the chain (so a verify still covers them),
 * but they are the most sensitive fields on the row and the dashboard has no use for them. Don't ship PII to
 * a browser for a list view that never displays it.
 */
export async function listAuthAuditEntries(
  tx: TenantTx,
  input: { afterSeq?: number | null; limit: number },
): Promise<AuthAuditListPage> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const after = input.afterSeq ?? null;

  const rows = await tx<
    {
      seq: string | number;
      event_type: AuthAuditEventType;
      actor: string | null;
      target_id: string | null;
      metadata: unknown;
      created_at: Date;
    }[]
  >`
    select seq, event_type, actor, target_id, metadata, created_at
      from auth_audit_event
     ${after === null ? tx`` : tx`where seq < ${after}`}
     order by seq desc
     limit ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((r) => ({
    seq: Number(r.seq),
    eventType: r.event_type,
    actor: r.actor,
    targetId: r.target_id,
    metadata: r.metadata ?? null,
    createdAt: r.created_at,
  }));
  return { items, nextSeq: hasMore ? (items[items.length - 1]?.seq ?? null) : null };
}

/** Distinguishes the auth-audit advisory-lock space from audit_log's and any other lock user. */
const AUTH_AUDIT_LOCK_NAMESPACE = 0x41414531; // "AAE1"

/** Coerce a DB bytea (postgres.js returns a Node Buffer) to a clean Uint8Array view. */
function toBytes(value: Uint8Array | null): Uint8Array | null {
  return value === null ? null : Uint8Array.from(value);
}

/**
 * Append the next row to an org's auth-audit chain and return the stored row. Runs inside the
 * caller's tenant transaction `tx`; takes a per-org advisory lock first so head-read + insert is
 * atomic. `key` is the audit HMAC key from the runtime binding. Re-entrant within one tx, so two
 * appends in a single mint transaction chain correctly (seq N then N+1).
 */
export async function appendAuthAuditEntry(
  tx: TenantTx,
  key: CryptoKey,
  input: AuthAuditAppendInput,
): Promise<StoredAuthAuditRow> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, ${AUTH_AUDIT_LOCK_NAMESPACE}))`;

  const [head] = await tx<{ seq: string | number; row_hash: Uint8Array }[]>`
    select seq, row_hash from auth_audit_event
    where org_id = ${input.orgId}
    order by seq desc
    limit 1`;

  const prevHash = head ? toBytes(head.row_hash) : null;
  const seq = head ? Number(head.seq) + 1 : 1;

  // Canonicalize the IP so the HASHED form matches what the inet column STORES and reads back
  // (postgres/postgres.js compress IPv6, drop leading zeros, and elide the /32|/128 host mask).
  // Returning the value AS inet (not ::text) routes it through the SAME postgres.js deserializer the
  // readback uses, so write-hash == read-hash exactly. Hashing the raw input string would make a
  // legitimately-written row fail its own verifier. An invalid IP throws here (the ::inet cast) —
  // fail-loud at write, never a silent unverifiable row.
  let ip: string | null = null;
  if (input.ip != null) {
    const [normalized] = await tx<{ ip: string }[]>`select (${input.ip})::inet as ip`;
    if (!normalized) throw new Error("auth-audit: ip normalization returned no row");
    ip = normalized.ip;
  }

  const entry: AuthAuditEntry = {
    orgId: input.orgId,
    seq,
    actor: input.actor,
    eventType: input.eventType,
    targetId: input.targetId ?? null,
    ip,
    geo: input.geo ?? null,
    metadata: input.metadata ?? null,
  };
  const rowHash = await computeAuthAuditRowHash(key, prevHash, entry);

  await tx`
    insert into auth_audit_event
      (org_id, seq, actor, event_type, target_id, ip, geo, metadata, prev_hash, row_hash)
    values
      (${entry.orgId}, ${entry.seq}, ${entry.actor}, ${entry.eventType}, ${entry.targetId},
       ${entry.ip},
       ${entry.geo === null ? null : tx.json(entry.geo as Parameters<typeof tx.json>[0])}::jsonb,
       ${entry.metadata === null ? null : tx.json(entry.metadata as Parameters<typeof tx.json>[0])}::jsonb,
       ${prevHash}, ${rowHash})`;

  return { ...entry, prevHash, rowHash };
}

interface AuthAuditRowShape {
  org_id: string;
  seq: string | number;
  actor: string | null;
  event_type: AuthAuditEventType;
  target_id: string | null;
  ip: string | null;
  geo: unknown;
  metadata: unknown;
  prev_hash: Uint8Array | null;
  row_hash: Uint8Array;
}

const toStoredAuthRow = (r: AuthAuditRowShape): StoredAuthAuditRow => ({
  orgId: r.org_id,
  seq: Number(r.seq),
  actor: r.actor,
  eventType: r.event_type,
  targetId: r.target_id,
  ip: r.ip,
  geo: r.geo ?? null,
  metadata: r.metadata ?? null,
  prevHash: toBytes(r.prev_hash),
  rowHash: toBytes(r.row_hash)!,
});

/**
 * Read an org's full auth-audit chain (ascending seq), ready for verification/export. Runs under the
 * caller's RLS context, so it returns exactly this org's rows. UNBOUNDED — the whole chain in memory; for
 * verification prefer {@link verifyAuthAuditChainPaged}, which streams it a page at a time (#663).
 */
export async function readAuthAuditChain(
  tx: TenantTx,
  orgId: string,
): Promise<StoredAuthAuditRow[]> {
  const rows = await tx<AuthAuditRowShape[]>`
    select org_id, seq, actor, event_type, target_id, ip, geo, metadata, prev_hash, row_hash
    from auth_audit_event
    where org_id = ${orgId}
    order by seq asc`;

  return rows.map(toStoredAuthRow);
}

/**
 * A keyset position in auth_audit_event's PHYSICAL ordering: the last read row's `(seq, id)`. `id` is the
 * `bigserial` primary key, so `(seq, id)` is a TOTAL order even on a tampered chain that duplicated a seq —
 * which a seq-only keyset could not page safely: with two rows sharing seq N, `seq > N` skips the second one
 * whenever the page boundary falls between them, and the whole-chain verifier's `duplicate_seq` detection is
 * lost. Ordering and paging by the compound key never skips or re-reads a boundary row. Mirrors wha1's
 * {@link import("./audit-append").AuditPageCursor} (#663). (listAuthAuditEntries keysets on seq alone — but
 * that is a display listing, not verification; do NOT reuse its keyset here.)
 */
export interface AuthAuditPageCursor {
  readonly seq: number;
  /** The `bigserial` PK as text — only ever compared in SQL, never used for arithmetic here. */
  readonly id: string;
}

/** One page of an org's aae1 chain in physical `(seq asc, id asc)` order, plus the keyset to resume after it
 *  (null once the chain is exhausted). Backed by the `unique (org_id, seq)` index. `after === null` reads from
 *  the very START — so the true minimum row is seen and a forged pre-genesis row (`seq <= 0`) is caught,
 *  exactly as the whole-chain verifier would; a `seq > 0` first page would silently skip it (#663). */
export async function readAuthAuditChainPage(
  tx: TenantTx,
  orgId: string,
  after: AuthAuditPageCursor | null,
  limit: number,
): Promise<{ rows: StoredAuthAuditRow[]; nextCursor: AuthAuditPageCursor | null }> {
  const rows = await tx<(AuthAuditRowShape & { id: string })[]>`
    select id, org_id, seq, actor, event_type, target_id, ip, geo, metadata, prev_hash, row_hash
    from auth_audit_event
    where org_id = ${orgId}
      ${after ? tx`and (seq, id) > (${after.seq}::bigint, ${after.id}::bigint)` : tx``}
    order by seq asc, id asc
    limit ${limit}`;
  const last = rows[rows.length - 1];
  return {
    rows: rows.map(toStoredAuthRow),
    nextCursor: last ? { seq: Number(last.seq), id: last.id } : null,
  };
}

/** How many auth-audit rows to hold in memory per verification page. Bounds the Worker's peak memory
 *  independent of chain length (#663); the `unique (org_id, seq)` index makes each page a cheap range read. */
export const AUTH_AUDIT_CHAIN_PAGE_SIZE = 1000;

/**
 * Verify an org's whole aae1 chain WITHOUT materialising it — read it a page at a time and walk each page with
 * {@link verifyAuthAuditChainChunk}, carrying the prior page's tail cursor across the boundary so every check
 * (seq contiguity, prev_hash link, HMAC, duplicate/genesis) holds exactly as the whole-chain form does. Fixes
 * #663: `readAuthAuditChain` returned the ENTIRE chain, an unbounded result set that grows with org age — a
 * Worker OOM risk. Mirrors the wha1 chain's verifyAuditChainPaged (#636).
 *
 * Takes the pool (`app`), not a transaction: each page is read in its OWN short `withTenant` transaction, so
 * the pooled connection is RELEASED between pages instead of being pinned open across the whole (CPU-bound)
 * per-row HMAC verification — which, on a long chain, could exceed an idle-in-transaction/statement timeout or
 * starve concurrent tenant requests. The HMAC walk runs between reads, outside any tx.
 *
 * WORM-safe across the several MVCC snapshots the pages span: auth_audit_event is append-only (the
 * no_update/no_delete/no_truncate triggers in migration 0013 make mid-chain rows immutable), so the ONLY
 * concurrent change to an org's chain is a new row appended at the TAIL — which just lets the walk verify a
 * longer, still-contiguous prefix. No page boundary can tear. (A superuser tamper that bypasses the WORM
 * triggers is exactly what a verify is meant to CATCH; racing one mid-verify is no different from verifying a
 * millisecond before or after it.)
 */
export async function verifyAuthAuditChainPaged(
  app: Sql,
  orgId: string,
  key: CryptoKey,
  pageSize: number = AUTH_AUDIT_CHAIN_PAGE_SIZE,
): Promise<AuthAuditChainResult> {
  // A non-positive pageSize would read `limit 0` (or negative), get an empty first page, and FALSELY report
  // any chain — even a tampered one — as valid. Refuse it rather than silently certify nothing.
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(
      `verifyAuthAuditChainPaged pageSize must be a positive integer, got ${pageSize}`,
    );
  }
  let cursor: AuthAuditChainCursor | null = null; // chain-LINK cursor (seq, rowHash) for the chunk walker
  let after: AuthAuditPageCursor | null = null; // READ keyset cursor (seq, id)
  let verified = 0;
  for (;;) {
    const { rows, nextCursor } = await withTenant(app, orgId, (tx) =>
      readAuthAuditChainPage(tx, orgId, after, pageSize),
    );
    if (rows.length === 0) break;
    const result = await verifyAuthAuditChainChunk(key, orgId, rows, cursor, verified);
    if (!result.ok) return result;
    cursor = result.tail;
    verified = result.rowsVerified;
    after = nextCursor;
    if (rows.length < pageSize) break; // a short page is the tail of the chain
  }
  return { ok: true, rowsVerified: verified };
}
