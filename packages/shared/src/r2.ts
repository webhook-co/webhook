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
 *
 * `storedKey` is TYPED as string but validated as `unknown` at runtime: this is a cross-Worker RPC
 * boundary (api/web → engine `DeliverArgs`), and the api/web/engine Workers deploy on independent CDs.
 * During a rolling-deploy skew a caller on the previous release can omit `payloadR2Key`, so a missing /
 * non-string value must FAIL CLOSED (null → the dispatcher records a retryable `failed` that self-heals
 * once both sides finish deploying) rather than throw `undefined.startsWith` out of the deliver RPC.
 */
export function readPayloadKey(
  orgId: string,
  endpointId: string,
  storedKey: string,
): string | null {
  if (typeof storedKey !== "string") return null;
  const prefix = endpointPrefix(orgId, endpointId);
  if (!storedKey.startsWith(prefix)) return null;
  // The suffix is an opaque sha256 hex object name — no separators, no traversal.
  const suffix = storedKey.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(suffix)) return null;
  return storedKey;
}

// A standalone `org/{uuid}/ep/{uuid}/{sha256hex}` shape check (no pre-parsed org/endpoint needed) — the
// PREFIX FENCE for the orphan sweep (S6c-iii). DELIBERATELY strict (UUID-shaped org + endpoint): a key that
// isn't exactly the write-side format is skipped and NEVER deleted, so the destructive sweep can only ever
// touch objects that look like our own payload bodies. Kept next to `payloadR2Key`/`endpointPrefix` so the
// three can't drift.
const WELL_FORMED_PAYLOAD_KEY =
  /^org\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ep\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;

/** True when `key` is exactly the `org/{uuid}/ep/{uuid}/{sha256hex}` payload-object shape. */
export function isWellFormedPayloadKey(key: string): boolean {
  return typeof key === "string" && WELL_FORMED_PAYLOAD_KEY.test(key);
}

/**
 * The DETERMINISTIC R2 object key for a user's uploaded avatar — one key per user, overwritten on re-upload.
 * Deterministic (from the user id) so the serve path derives it straight from the session with NO database
 * read, and it reveals nothing about the image content (no content-hash → no confirmation oracle). The bucket
 * is private (Worker-binding access only), so a key for another user is never reachable anyway.
 */
export function avatarR2Key(userId: string): string {
  return `user/${userId}/avatar.webp`;
}

// The PREFIX FENCE for the avatar orphan sweep — same "strict allowlist, never delete anything off-shape"
// philosophy as WELL_FORMED_PAYLOAD_KEY. The user-id segment is our own controlled id charset (letters,
// digits, `_`, `-`).
const WELL_FORMED_AVATAR_KEY = /^user\/[A-Za-z0-9_-]+\/avatar\.webp$/;

/** True when `key` is exactly the `user/{userId}/avatar.webp` avatar-object shape. */
export function isWellFormedAvatarKey(key: string): boolean {
  return typeof key === "string" && WELL_FORMED_AVATAR_KEY.test(key);
}

/**
 * The DETERMINISTIC R2 object key for an organization's uploaded logo — one key per org, overwritten on
 * re-upload. Lives in the same private bucket as user avatars, namespaced under `org/…` (avatars are `user/…`).
 * Deterministic (from the org id) so the serve path derives it straight from the resolved org with no extra
 * DB read, and it reveals nothing about the image content.
 */
export function orgLogoR2Key(orgId: string): string {
  return `org/${orgId}/logo.webp`;
}

// The PREFIX FENCE for the org-logo orphan sweep. UUID-strict (org ids are real uuids) — same "strict
// allowlist, never delete anything off-shape" philosophy as WELL_FORMED_PAYLOAD_KEY. The `/logo.webp` leaf
// keeps it disjoint from the `org/{uuid}/ep/{uuid}/{sha256}` payload keys in the same `org/` namespace.
const WELL_FORMED_ORG_LOGO_KEY =
  /^org\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/logo\.webp$/;

/** True when `key` is exactly the `org/{orgId}/logo.webp` org-logo-object shape. */
export function isWellFormedOrgLogoKey(key: string): boolean {
  return typeof key === "string" && WELL_FORMED_ORG_LOGO_KEY.test(key);
}
