// The CLI loopback-completion bounce. The consent decision can't hand the browser a CLIENT-SIDE navigation
// to the http://127.0.0.1 loopback: Chrome's Private Network Access blocks a script-initiated
// public-https → local-http top-level nav, so `window.location.assign(loopback)` silently no-ops and the CLI
// never receives its callback. So the decision returns a SAME-ORIGIN `/consent/complete?c=<ticket>` bounce,
// and GET /consent/complete issues a SERVER 302 to the loopback — the standard RFC 8252 native-app pattern
// (browsers follow a top-level 302 to a loopback literal).
//
// This ticket seals the server-computed, already-loopback-validated redirect URL so /consent/complete can
// never be turned into an open redirector. Pure crypto, reusing the consent-ticket HMAC codec + key
// (CONSENT_TICKET_KEY); a fixed type tag domain-separates it from a consent ticket (the two share the key),
// so neither can be replayed as the other.

import {
  b64urlToBytes,
  bytesToB64url,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "@webhook-co/shared";

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag — matches the consent-ticket/cursor codec.
const TICKET_TYPE = "loopback_complete";

interface CompletionPayload {
  /** Domain-separation tag vs the consent ticket (shared key) — a consent ticket lacks this, so it fails. */
  t: typeof TICKET_TYPE;
  /** The server-computed, loopback-validated redirect URL (callback?code=… or ?error=access_denied&…). */
  redirectTo: string;
  /** Unix seconds — valid through exp (inclusive), dead strictly after. */
  exp: number;
}

async function tag(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  // The cast bridges node-lib Uint8Array vs DOM WebCrypto BufferSource under apps/auth's DOM tsconfig
  // (the same crypto.subtle friction consent-ticket.ts notes).
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>),
  );
  return sig.slice(0, HMAC_BYTES);
}

/** Seal a loopback redirect URL into an opaque, MAC-protected, short-lived completion ticket. */
export async function signLoopbackTicket(
  redirectTo: string,
  key: CryptoKey,
  exp: number,
): Promise<string> {
  const payload: CompletionPayload = { t: TICKET_TYPE, redirectTo, exp };
  const bytes = utf8Encoder.encode(JSON.stringify(payload));
  const mac = await tag(key, bytes);
  return `${bytesToB64url(bytes)}.${bytesToB64url(mac)}`;
}

/**
 * Verify + open a completion ticket. Returns the sealed redirectTo only if the MAC recomputes, the type tag
 * matches, and it hasn't expired. Any malformed/tampered/forged/expired/wrong-type ticket returns null
 * (never throws), so the caller fails closed on a single null check (→ 400, never an open redirect).
 */
export async function verifyLoopbackTicket(
  ticket: string,
  key: CryptoKey,
  nowSeconds: number,
): Promise<string | null> {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return null;
  let bytes: Uint8Array;
  let presentedMac: Uint8Array;
  try {
    bytes = b64urlToBytes(ticket.slice(0, dot));
    presentedMac = b64urlToBytes(ticket.slice(dot + 1));
  } catch {
    return null;
  }
  const expectedMac = await tag(key, bytes);
  if (!timingSafeEqual(presentedMac, expectedMac)) return null;
  let payload: CompletionPayload;
  try {
    payload = JSON.parse(utf8Decoder.decode(bytes)) as CompletionPayload;
  } catch {
    return null;
  }
  if (payload.t !== TICKET_TYPE) return null;
  if (typeof payload.redirectTo !== "string" || !payload.redirectTo) return null;
  if (typeof payload.exp !== "number" || nowSeconds > payload.exp) return null;
  return payload.redirectTo;
}
