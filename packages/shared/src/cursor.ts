import {
  b64urlToBytes,
  bytesToB64url,
  importHmacKey,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "./bytes";

// The opaque pagination/resume cursor. Encodes (received_at, id) — a
// stable total order with a UUIDv7 tiebreaker — used identically by the CLI (resume
// token), the API (pagination cursor), and MCP. The cursor is HMAC-signed so a client
// can't forge or tamper with it: a surface hands the cursor back to us verbatim
// and we reject anything whose MAC doesn't verify.

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag — plenty for tamper-evidence.

export interface Cursor {
  /** Server-assigned receive time (ms precision; the order key). */
  readonly receivedAt: Date;
  /** UUIDv7 event id — the same-millisecond tiebreaker. */
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

function payloadBytes(c: Cursor): Uint8Array {
  return utf8Encoder.encode(`${c.receivedAt.getTime()}:${c.id}`);
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

/** Decode + verify a cursor token. Throws InvalidCursorError on a bad MAC or shape. */
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
  const [msStr, id] = utf8Decoder.decode(payload).split(":");
  const ms = Number(msStr);
  if (!Number.isFinite(ms) || !id) {
    throw new InvalidCursorError("cursor payload is malformed");
  }
  return { receivedAt: new Date(ms), id };
}
