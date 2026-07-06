import { bytesToHex, utf8Encoder } from "./bytes";

// Per-event R2 object key. The object NAME is
// hash(endpoint_id, dedup_key, content_hash), NOT the event UUIDv7:
//   * same dedup_key AND same body (a genuine retry) -> same key -> idempotent PUT, no orphan churn;
//   * same dedup_key but a DIFFERENT body (a forged/spoofed request that re-derives the key from
//     unverified input) -> DIFFERENT key -> it CANNOT overwrite the legit event's stored object.
//     Readers use the STORED payload_r2_key, so a dedup no-op leaves the winning body untouched;
//   * distinct events (distinct dedup_key) -> distinct keys -> per-event-delete retention stays safe,
//     even when two distinct events carry byte-identical bodies (content_hash alone would re-collide).
// The org/endpoint PREFIX is preserved for prefix-listing (the orphan-reconcile prune) and for
// residency (jurisdiction-pinned buckets), and is the read-side principal fence (readPayloadKey).
// A refcount table + true content-addressing is deferred to scale.

const NUL = String.fromCharCode(0); // unambiguous separator; a UUID endpoint_id can never contain it

/** The listable prefix for an endpoint's bodies (orphan-reconcile sweep, retention). */
export function endpointPrefix(orgId: string, endpointId: string): string {
  return `org/${orgId}/ep/${endpointId}/`;
}

/**
 * The R2 object key for an event body. Deterministic in (endpoint_id, dedup_key, content_hash).
 * The separators are NUL (which a UUID endpoint_id can't contain) and the content_hash is a
 * fixed-width 64-char hex suffix, so the tuple maps unambiguously to one key. Folding content_hash
 * in is the forged-overwrite defense: a request that re-derives an existing dedup_key from
 * unverified input but ships a different body hashes to a different object and cannot clobber the
 * legitimate payload (readers resolve the STORED key, never re-derive from the request).
 */
export async function payloadR2Key(
  orgId: string,
  endpointId: string,
  dedupKey: string,
  contentHash: Uint8Array,
): Promise<string> {
  const input = utf8Encoder.encode(
    `${endpointId}${NUL}${dedupKey}${NUL}${bytesToHex(contentHash)}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `${endpointPrefix(orgId, endpointId)}${bytesToHex(digest)}`;
}

/**
 * Validate a STORED payload_r2_key before using it to read an object, from an authenticated
 * (orgId, endpointId) principal. The engine delivery/replay readers resolve the key persisted on
 * the event row rather than re-deriving it (the key now depends on content_hash, which the reader
 * would have to fetch the body to recompute — a chicken-and-egg). To keep the "never trust a handed
 * key" guarantee, we fence the key to the principal's own prefix: even a poisoned column value can
 * never point at another tenant's object. Returns the key if valid, else null (caller fails closed).
 */
export function readPayloadKey(
  orgId: string,
  endpointId: string,
  storedKey: string,
): string | null {
  const prefix = endpointPrefix(orgId, endpointId);
  if (!storedKey.startsWith(prefix)) return null;
  // The suffix is an opaque sha256 hex object name — no separators, no traversal.
  const suffix = storedKey.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(suffix)) return null;
  return storedKey;
}
