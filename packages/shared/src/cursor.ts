import {
  b64urlToBytes,
  bytesToB64url,
  importHmacKey,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "./bytes";

// The opaque pagination/resume cursor. Encodes a full-microsecond order key + a UUIDv7 tiebreaker — a stable
// total order used identically by the CLI (resume token), the API (pagination cursor), and MCP. The order key
// is a UTC ISO-8601 MICROSECOND string (e.g. "2026-06-11T12:00:00.007300Z"), projected by the SQL reads via
// `to_char(<col> at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, so the keyset compares against the RAW
// timestamptz column at exact µs (`${orderKey}::timestamptz`) — which a plain btree index can serve, unlike the
// old ms-truncated `date_trunc` expression. A JS `Date` is ms-only, so the key is deliberately a STRING and is
// never round-tripped through `Date`. The cursor is HMAC-signed so a client can't forge or tamper with it.
//
// The payload is versioned: `2|<iso-µs>|<uuid>` (the `|` delimiter — the ISO key itself contains `:`). A legacy
// v1 payload (`<ms>:<id>`, millisecond precision) is FAILED CLOSED at decode even though its MAC verifies under
// the same key: a ms→µs upgrade can't be gapless when a boundary millisecond holds more than one row, so the
// only correct behavior is to reject it (the client restarts pagination from the first page).

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag — plenty for tamper-evidence.
const CURSOR_VERSION = "2";

/** UTC ISO-8601 with EXACTLY 6 fractional (microsecond) digits and a literal Z — the projected `to_char` shape. */
export const ORDER_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface Cursor {
  /**
   * The UTC ISO-8601 microsecond order key, e.g. "2026-06-11T12:00:00.007300Z". A STRING, not a Date — JS
   * Date is millisecond-only and would silently truncate the µs the keyset depends on.
   */
  readonly orderKey: string;
  /** UUIDv7 row id — the same-instant tiebreaker. */
  readonly id: string;
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** Bytes in the cursor HMAC key (CURSOR_KEY). */
const CURSOR_KEY_BYTES = 32;

/**
 * Import raw key bytes as a non-extractable HMAC key for cursor signing. CURSOR_KEY is a 32-byte
 * secret shared across surfaces; reject any other length so a misconfigured/truncated key fails loud
 * at construction rather than silently signing cursors with a weak/mismatched key.
 */
export function importCursorKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== CURSOR_KEY_BYTES) {
    throw new Error(`CURSOR_KEY must be ${CURSOR_KEY_BYTES} bytes, got ${raw.length}`);
  }
  return importHmacKey(raw);
}

/**
 * Epoch milliseconds → the cursor's 6-digit UTC ISO-µs order key (`…sss000Z`). The inverse of reading an
 * order key as a `Date`. Used to UPGRADE a pre-µs millisecond position (a legacy DO/web cursor from before
 * this change) to a v2 order key IN PLACE: the old value was already ms-precision, so `…sss000Z` resumes
 * from the exact same millisecond boundary — no gap, at most a few same-ms duplicates (which at-least-once
 * already tolerates), never a full-backlog re-flood. `toISOString()` is always `…sssZ` (3 frac digits, UTC).
 */
export function msToOrderKey(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, -1)}000Z`;
}

/**
 * Advisory head-lag in milliseconds: `now - orderKey`, floored at 0. The µs order key is intentionally
 * coarsened to ms here (a `Date` is ms-only) — this is a display/backpressure hint, never a keyset boundary.
 * Shared by the API status read and the tunnel status frame so the two surfaces can't drift on the math.
 */
export function orderKeyLagMs(orderKey: string, nowMs: number): number {
  return Math.max(0, nowMs - new Date(orderKey).getTime());
}

function payloadBytes(c: Cursor): Uint8Array {
  return utf8Encoder.encode(`${CURSOR_VERSION}|${c.orderKey}|${c.id}`);
}

async function tag(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return sig.slice(0, HMAC_BYTES);
}

/** Encode a cursor to an opaque, MAC-protected token. */
export async function encodeCursor(cursor: Cursor, key: CryptoKey): Promise<string> {
  const payload = payloadBytes(cursor);
  const mac = await tag(key, payload);
  return `${bytesToB64url(payload)}.${bytesToB64url(mac)}`;
}

/** Decode + verify a cursor token. Throws InvalidCursorError on a bad MAC, wrong version, or bad shape. */
export async function decodeCursor(token: string, key: CryptoKey): Promise<Cursor> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    throw new InvalidCursorError("cursor is not in the form <payload>.<mac>");
  }
  let payload: Uint8Array;
  let presentedMac: Uint8Array;
  try {
    payload = b64urlToBytes(token.slice(0, dot));
    presentedMac = b64urlToBytes(token.slice(dot + 1));
  } catch {
    throw new InvalidCursorError("cursor is not valid base64url");
  }
  const expectedMac = await tag(key, payload);
  if (!timingSafeEqual(presentedMac, expectedMac)) {
    throw new InvalidCursorError("cursor signature does not verify");
  }
  // Shape-check AFTER the MAC verifies. A legacy v1 (`<ms>:<id>`) payload's MAC verifies under the same key, so
  // the version + delimiter guard is what fails it closed — the ONLY safe response to a non-µs cursor.
  const parts = utf8Decoder.decode(payload).split("|");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) {
    throw new InvalidCursorError("cursor is not a supported version");
  }
  const [, orderKey, id] = parts;
  if (!ORDER_KEY_RE.test(orderKey!) || !UUID_RE.test(id!)) {
    throw new InvalidCursorError("cursor payload is malformed");
  }
  return { orderKey: orderKey!, id: id! };
}
