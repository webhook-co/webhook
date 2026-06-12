import { bytesToHex, utf8Encoder } from "./bytes";

// Per-event R2 object key (§0.1 layout, hardened by H1). The object NAME is
// hash(endpoint_id, dedup_key), NOT the event UUIDv7 and NOT content_hash:
//   * same dedup_key (a retry) -> same key -> idempotent PUT, no orphan churn;
//   * distinct events -> distinct keys -> per-event-delete retention stays safe;
//   * (content_hash as the key would re-collide distinct events with identical bodies.)
// The org/endpoint PREFIX is preserved for prefix-listing (the orphan-reconcile prune)
// and for residency (jurisdiction-pinned buckets). Content-addressing + a refcount
// table is deferred to scale.

/** The listable prefix for an endpoint's bodies (orphan-reconcile sweep, retention). */
export function endpointPrefix(orgId: string, endpointId: string): string {
  return `org/${orgId}/ep/${endpointId}/`;
}

/**
 * The R2 object key for an event body. Deterministic in (endpoint_id, dedup_key): the
 * separator is NUL, which a UUID endpoint_id can't contain, so the (endpoint, dedup)
 * pair maps unambiguously to one key.
 */
export async function payloadR2Key(
  orgId: string,
  endpointId: string,
  dedupKey: string,
): Promise<string> {
  const input = utf8Encoder.encode(`${endpointId}\u0000${dedupKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `${endpointPrefix(orgId, endpointId)}${bytesToHex(digest)}`;
}
