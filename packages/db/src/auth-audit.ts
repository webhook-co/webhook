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

import type { TenantTx } from "./client";

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
  | "reauth";

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

/**
 * Read an org's full auth-audit chain (ascending seq), ready for verification/export. Runs under the
 * caller's RLS context, so it returns exactly this org's rows.
 */
export async function readAuthAuditChain(
  tx: TenantTx,
  orgId: string,
): Promise<StoredAuthAuditRow[]> {
  const rows = await tx<
    {
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
    }[]
  >`
    select org_id, seq, actor, event_type, target_id, ip, geo, metadata, prev_hash, row_hash
    from auth_audit_event
    where org_id = ${orgId}
    order by seq asc`;

  return rows.map((r) => ({
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
  }));
}
