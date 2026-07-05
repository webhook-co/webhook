import {
  b64urlToBytes,
  bytesToB64url,
  importHmacKey,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "./bytes";

// The live-events listen ticket — a short-lived, HMAC-signed grant that lets the DASHBOARD open the
// engine's `GET /listen` WebSocket without an api-key bearer. The dashboard lives on app.webhook.co
// (session cookie); `/listen` is on the cookieless wbhk.my apex, and the browser WebSocket API can't send
// an Authorization header. So a session-authed web action mints this ticket (after checking the endpoint
// belongs to the caller's org under RLS) and the browser presents it via the WebSocket subprotocol; the
// engine verifies it + an Origin allowlist. Because the browser controls the query string and can't send a
// header, the ticket CARRIES the org + endpoint in its signed payload — the engine derives the DO binding
// from the verified ticket, never from the client. Codec mirrors the MCP session-binding / cursor envelope:
// `<base64url(json)>.<base64url(mac)>`, MAC = first 16 bytes of HMAC-SHA256. Read-only (`events.tail`).

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag (matches the session-binding / cursor codec).
const LISTEN_TICKET_KEY_BYTES = 32; // a dedicated 32-byte secret (LISTEN_TICKET_KEY), shared engine↔web.

/**
 * The current envelope version. `verifyListenTicket` rejects any envelope whose `v` is missing or != this,
 * so a codec change is a clean break: mismatched tickets fail closed (→ null) and the client re-mints.
 */
export const LISTEN_TICKET_VERSION = 1;

/**
 * Ticket lifetime (seconds). Kept SHORT — the ticket only has to survive the round-trip from mint to the
 * WebSocket handshake, so a leaked ticket is replayable for at most this window (and only grants read-only
 * tailing of the one endpoint it names). `mintListenTicket` stamps `exp = nowSeconds + this`.
 */
export const LISTEN_TICKET_TTL_SECONDS = 60;

/** The signed grant: version + org + endpoint + expiry. The engine derives the DO binding from o/e. */
interface ListenTicketEnvelope {
  /** Envelope version — must equal LISTEN_TICKET_VERSION to verify. */
  v: number;
  /** The org the ticket authorizes (set from the minting session, never the client). */
  o: string;
  /** The endpoint the ticket authorizes tailing (validated to belong to `o` at mint time). */
  e: string;
  /** Unix seconds — the ticket is dead strictly after this (now > exp). */
  exp: number;
}

/** The verified grant returned to the engine. */
export interface ListenTicketGrant {
  readonly orgId: string;
  readonly endpointId: string;
}

/**
 * Import raw key bytes as a non-extractable HMAC key. LISTEN_TICKET_KEY is a dedicated 32-byte secret,
 * byte-identical in the engine (verify) and web (mint); reject any other length so a misconfigured or
 * truncated key fails loud at construction rather than silently minting unverifiable tickets.
 */
export async function importListenTicketKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== LISTEN_TICKET_KEY_BYTES) {
    throw new Error(
      `LISTEN_TICKET_KEY must be ${LISTEN_TICKET_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return importHmacKey(raw);
}

async function tag(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  // The cast bridges the node-lib Uint8Array vs DOM WebCrypto BufferSource types (the same crypto.subtle
  // friction the session-binding / db code hits — see the tsconfig-boundary note); no runtime effect.
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>),
  );
  return sig.slice(0, HMAC_BYTES);
}

/**
 * Mint a signed listen ticket binding `{orgId, endpointId}` with an expiry `nowSeconds +
 * LISTEN_TICKET_TTL_SECONDS`. `nowSeconds` is the injected clock (Unix seconds) so the codec stays pure and
 * the expiry is deterministically testable. The caller (a session-authed web action) MUST have verified the
 * endpoint belongs to the org before minting — this codec signs whatever it's given.
 */
export async function mintListenTicket(
  key: CryptoKey,
  grant: ListenTicketGrant,
  nowSeconds: number,
): Promise<string> {
  const env: ListenTicketEnvelope = {
    v: LISTEN_TICKET_VERSION,
    o: grant.orgId,
    e: grant.endpointId,
    exp: nowSeconds + LISTEN_TICKET_TTL_SECONDS,
  };
  const bytes = utf8Encoder.encode(JSON.stringify(env));
  const mac = await tag(key, bytes);
  return `${bytesToB64url(bytes)}.${bytesToB64url(mac)}`;
}

/**
 * Verify a listen ticket and return its `{orgId, endpointId}` grant ONLY when the MAC recomputes AND the
 * envelope is the current version AND it has not expired (`nowSeconds <= exp`, inclusive). Any malformed,
 * tampered, forged, wrong-key, stale-version, or expired ticket returns null (never throws) — the cases are
 * indistinguishable to the caller (no oracle). `nowSeconds` is the injected clock (Unix seconds).
 */
export async function verifyListenTicket(
  key: CryptoKey,
  token: string,
  nowSeconds: number,
): Promise<ListenTicketGrant | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  let bytes: Uint8Array;
  let presentedMac: Uint8Array;
  try {
    bytes = b64urlToBytes(token.slice(0, dot));
    presentedMac = b64urlToBytes(token.slice(dot + 1));
  } catch {
    return null;
  }
  const expectedMac = await tag(key, bytes);
  if (!timingSafeEqual(presentedMac, expectedMac)) return null;
  let env: ListenTicketEnvelope;
  try {
    env = JSON.parse(utf8Decoder.decode(bytes)) as ListenTicketEnvelope;
  } catch {
    return null;
  }
  if (env.v !== LISTEN_TICKET_VERSION) return null;
  if (typeof env.exp !== "number" || nowSeconds > env.exp) return null;
  if (typeof env.o !== "string" || env.o === "" || typeof env.e !== "string" || env.e === "") {
    return null;
  }
  return { orgId: env.o, endpointId: env.e };
}
