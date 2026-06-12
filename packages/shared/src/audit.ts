import { z } from "zod";

import { concatBytes, importHmacKey, timingSafeEqual, utf8Encoder } from "./bytes";

// The canonical audit serialization + per-org HMAC-keyed hash chain (§0.7, H2, M1).
// Frozen here so the chain is reproducible and verifiable across every surface and by
// the (post-freeze) audit verifier. The HMAC key lives OUTSIDE the DB role, so a DB
// compromise can't forge a chain; the DB only enforces the chain STRUCTURE
// (contiguous seq + prev_hash linkage + immutability — see migration 0005).
//
// actor is the pseudonymous Better Auth user_id (M1), never raw PII. created_at is
// NOT part of the canonical form: the DB trigger stamps it server-side after the app
// computes the hash, and the table's immutability already protects it from edits.

const CANON_VERSION = "wha1";

/** The hashed control-plane audit fields. seq is the per-org monotonic sequence. */
export interface AuditEntry {
  readonly orgId: string;
  readonly seq: number;
  /** Pseudonymous actor (user_id), or null for system actions. */
  readonly actor: string | null;
  readonly action: string;
  readonly target: string | null;
}

export const AuditEntrySchema = z.object({
  orgId: z.uuid(),
  seq: z.number().int().positive(),
  actor: z.string().nullable(),
  action: z.string().min(1),
  target: z.string().nullable(),
});

/** Length-prefixed so no field value can be confused with a delimiter. */
function segment(value: string | null): string {
  if (value === null) return "_:";
  const byteLen = utf8Encoder.encode(value).length;
  return `${byteLen}:${value}`;
}

/** Deterministic byte serialization of the hashed audit fields. */
export function canonicalizeAuditEntry(entry: AuditEntry): Uint8Array {
  const canon =
    `${CANON_VERSION}|` +
    segment(entry.orgId) +
    segment(String(entry.seq)) +
    segment(entry.actor) +
    segment(entry.action) +
    segment(entry.target);
  return utf8Encoder.encode(canon);
}

/** Import raw key bytes as a non-extractable HMAC key for the audit chain. */
export function importAuditKey(raw: Uint8Array): Promise<CryptoKey> {
  return importHmacKey(raw);
}

/**
 * row_hash = HMAC(key, prev_hash || canonical(entry)). prevHash is null for the
 * genesis row (seq 1). Returns the full 32-byte tag stored as audit_log.row_hash.
 */
export async function computeAuditRowHash(
  key: CryptoKey,
  prevHash: Uint8Array | null,
  entry: AuditEntry,
): Promise<Uint8Array> {
  const input = concatBytes(prevHash ?? new Uint8Array(0), canonicalizeAuditEntry(entry));
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
}

/** Recompute and compare a row's hash (constant-time) — the verifier's per-row step. */
export async function verifyAuditRowHash(
  key: CryptoKey,
  prevHash: Uint8Array | null,
  entry: AuditEntry,
  expectedRowHash: Uint8Array,
): Promise<boolean> {
  const computed = await computeAuditRowHash(key, prevHash, entry);
  return timingSafeEqual(computed, expectedRowHash);
}
