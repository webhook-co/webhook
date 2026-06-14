import { z } from "zod";

import { b64ToBytes, bytesToB64, timingSafeEqual, utf8Encoder } from "./bytes";
import type { StoredAuditRow } from "./audit-chain";

// The WORM head-anchor format + cross-check (ADR-0004). Periodically the
// anchor cron records each org's chain head — (seq, row_hash) at a point in time — as a
// small, HMAC-signed object in an R2 bucket under a retention lock (write-once, no delete).
// Later, the verifier fetches the latest anchor and cross-checks it against the live chain:
// if the chain has been truncated below the anchored seq, or the row at that seq no longer
// matches the anchored row_hash, the tamper is detectable even though the attacker could
// recompute an internally-consistent chain. The anchor's own integrity rests on the SAME
// HMAC key the chain uses (held OUTSIDE the DB) AND the R2 retention lock — belt and braces.
//
// Detection window: an anchor proves "the head was (seq, row_hash) at anchoredAt". Rows
// written AND truncated entirely between two anchors were never captured, so the inherent
// detection window equals the cron interval — acceptable, stated, not hidden (ADR-0004).

export const ANCHOR_VERSION = 1 as const;

/** The chain head an anchor pins, plus when it was pinned. */
export interface AnchorPayload {
  readonly version: number;
  readonly orgId: string;
  readonly seq: number;
  /** The row_hash of the head row (audit_log.row_hash at `seq`). */
  readonly rowHash: Uint8Array;
  /** Epoch milliseconds when this anchor was produced. */
  readonly anchoredAt: number;
}

/** Length-prefixed so no field value can be confused with a delimiter (mirrors audit.ts). */
function segment(value: string): string {
  const byteLen = utf8Encoder.encode(value).length;
  return `${byteLen}:${value}`;
}

/** Deterministic canonical bytes the anchor MAC is computed over. */
export function canonicalizeAnchor(p: AnchorPayload): Uint8Array {
  return utf8Encoder.encode(
    `anc${p.version}|` +
      segment(p.orgId) +
      segment(String(p.seq)) +
      segment(bytesToB64(p.rowHash)) +
      segment(String(p.anchoredAt)),
  );
}

/** mac = HMAC(auditKey, canonical(anchor)). Same key family as the chain row hashes. */
export async function computeAnchorMac(key: CryptoKey, p: AnchorPayload): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, canonicalizeAnchor(p)));
}

const SerializedAnchorSchema = z.object({
  version: z.number().int().positive(),
  orgId: z.uuid(),
  seq: z.number().int().positive(),
  rowHash: z.string(),
  anchoredAt: z.number().int().nonnegative(),
  mac: z.string(),
});

/** The stored object form (JSON; bytes base64). Inspectable + format-frozen. */
export function serializeAnchor(p: AnchorPayload, mac: Uint8Array): string {
  return JSON.stringify({
    version: p.version,
    orgId: p.orgId,
    seq: p.seq,
    rowHash: bytesToB64(p.rowHash),
    anchoredAt: p.anchoredAt,
    mac: bytesToB64(mac),
  });
}

/** Parse + shape-validate a stored anchor; throws (zod/JSON) on a malformed object. */
export function parseAnchor(text: string): { payload: AnchorPayload; mac: Uint8Array } {
  const obj = SerializedAnchorSchema.parse(JSON.parse(text));
  return {
    payload: {
      version: obj.version,
      orgId: obj.orgId,
      seq: obj.seq,
      rowHash: b64ToBytes(obj.rowHash),
      anchoredAt: obj.anchoredAt,
    },
    mac: b64ToBytes(obj.mac),
  };
}

/** Build the payload + serialized object for an org's current head. */
export async function buildAnchor(
  key: CryptoKey,
  head: { orgId: string; seq: number; rowHash: Uint8Array },
  anchoredAt: number,
): Promise<{ payload: AnchorPayload; serialized: string }> {
  const payload: AnchorPayload = {
    version: ANCHOR_VERSION,
    orgId: head.orgId,
    seq: head.seq,
    rowHash: head.rowHash,
    anchoredAt,
  };
  const mac = await computeAnchorMac(key, payload);
  return { payload, serialized: serializeAnchor(payload, mac) };
}

/**
 * True iff the serialized anchor is a SUPPORTED version whose MAC recomputes (constant-time)
 * under `key`. An unknown version returns false: this verifier can't vouch for fields it doesn't
 * understand, even if the (version-bound) MAC checks out for newer code.
 */
export async function verifyAnchor(key: CryptoKey, text: string): Promise<boolean> {
  const { payload, mac } = parseAnchor(text);
  if (payload.version !== ANCHOR_VERSION) return false;
  return timingSafeEqual(await computeAnchorMac(key, payload), mac);
}

/** The prefix under which an org's anchors live (latest = lexically-greatest key). */
export function anchorR2Prefix(orgId: string): string {
  return `audit-anchors/${orgId}/`;
}

/**
 * The R2 object key for an anchor. Zero-padded seq gives lexical = numeric ordering, so the
 * latest anchor is the lexically-greatest key under the org prefix. The cron writes create-only
 * (write-once), so exactly one immutable anchor exists per head seq.
 */
export function anchorR2Key(orgId: string, seq: number): string {
  return `${anchorR2Prefix(orgId)}${String(seq).padStart(20, "0")}.json`;
}

export type AnchorCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "bad_anchor" | "bad_mac" | "wrong_org" | "head_below_anchor" | "hash_mismatch";
      readonly detail: string;
    };

/**
 * Cross-check a live chain against a stored anchor. Verifies the anchor MAC, then proves the
 * anchored head is still present and unchanged in the live rows:
 *   - no row at the anchored seq -> the chain was truncated below it (or that row is missing);
 *   - a row at the anchored seq with a different row_hash -> a fork/rewrite at the head.
 * Run ALONGSIDE verifyAuditChain (internal consistency) — this is the external truncation guard.
 */
export async function verifyChainAgainstAnchor(
  key: CryptoKey,
  orgId: string,
  rows: readonly StoredAuditRow[],
  anchorText: string,
): Promise<AnchorCheckResult> {
  let parsed: { payload: AnchorPayload; mac: Uint8Array };
  try {
    parsed = parseAnchor(anchorText);
  } catch {
    return { ok: false, kind: "bad_anchor", detail: "anchor object is malformed" };
  }
  const { payload, mac } = parsed;
  if (payload.version !== ANCHOR_VERSION) {
    return {
      ok: false,
      kind: "bad_anchor",
      detail: `unsupported anchor version ${payload.version}`,
    };
  }
  if (!timingSafeEqual(await computeAnchorMac(key, payload), mac)) {
    return {
      ok: false,
      kind: "bad_mac",
      detail: "anchor MAC does not verify (forged or wrong key)",
    };
  }
  if (payload.orgId !== orgId) {
    return {
      ok: false,
      kind: "wrong_org",
      detail: `anchor is for org ${payload.orgId}, not ${orgId}`,
    };
  }
  // Match the anchored row by seq AND org — never trust the caller to have pre-filtered to one
  // org, so a cross-org row at the same seq can't masquerade as this org's head.
  const row = rows.find((r) => r.seq === payload.seq && r.orgId === orgId);
  if (!row) {
    return {
      ok: false,
      kind: "head_below_anchor",
      detail: `no row at the anchored seq ${payload.seq} for org ${orgId}: the chain was truncated or that row removed`,
    };
  }
  if (!timingSafeEqual(row.rowHash, payload.rowHash)) {
    return {
      ok: false,
      kind: "hash_mismatch",
      detail: `row_hash at seq ${payload.seq} does not match the anchor (forked or rewritten)`,
    };
  }
  return { ok: true };
}
