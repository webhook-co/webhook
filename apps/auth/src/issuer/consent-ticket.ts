// A3c — the stateless signed consent ticket.
//
// `@cloudflare/workers-oauth-provider` has no server-side state store for an in-flight authorization
// (parseAuthRequest is stateless; completeAuthorization mints the grant fresh from an AuthRequest). So the
// authorization state must survive the consent round-trip CARRIED BY THE CLIENT — from /authorize, to Lane
// E's consent screen, back to /consent/decision. To make that safe it is sealed in an HMAC-signed, expiring
// envelope (a tampered/forged/expired ticket fails verification), modeled on the cursor codec
// (packages/shared/src/cursor.ts): `<base64url(json)>.<base64url(mac)>`.
//
// The ticket carries BOTH (a) the OAuth AuthRequest replayed into completeAuthorization at decision and the
// server-authenticated userId (re-checked against the live session there — it never comes from the page),
// and (b) the consent display fields Lane E's screen renders. It is pure crypto (Web Crypto + base64url),
// so it imports cleanly into both the wrangler-layer decision handler AND Lane E's Next consent page (no
// `cloudflare:workers`), unlike the provider helpers.

import type { ConsentRequest } from "@webhook-co/contract";
import {
  b64urlToBytes,
  bytesToB64url,
  importHmacKey,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "@webhook-co/shared";

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag — matches the cursor codec (tamper-evidence).
const TICKET_KEY_BYTES = 32; // a dedicated 32-byte secret (CONSENT_TICKET_KEY), never reused from another key.

/** The OAuth authorization request, replayed verbatim into completeAuthorization at the decision. */
export interface ConsentAuthRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string | string[];
}

/** The sealed fields common to every consent ticket (both the PKCE and device-code flows). */
interface ConsentTicketBase {
  /** The server-authenticated consenting user. Re-checked against the live session at the decision; the
   * page never supplies it. */
  userId: string;
  /** The resolved consent org (id + display name). */
  orgId: string;
  orgName: string;
  /** The granted (already intersected) scopes — what the key will be minted with. */
  scopes: string[];
  /** The validated audience/resource the resulting token is bound to. */
  audience: string;
  /** The requesting client id (→ ConsentRequest.client.id). */
  clientId: string;
  /** Display: the requesting client's human name. */
  clientName: string;
  /** Display: the device the user-code was entered on. Forward-looking — NOT populated in v1
   * (/device_authorization captures no device name yet); decideConsent forwards it into props if present. */
  device?: { name: string };
  /** Display: where the request originates (a trust signal). city/region/regionCode are best-effort geo
   *  from request.cf (optional/null when the edge resolved none). */
  origin: {
    ip: string;
    location: string | null;
    city?: string | null;
    region?: string | null;
    regionCode?: string | null;
  };
  /** ISO 8601 — the ~90d grant/refresh lifetime ceiling shown on the screen. */
  grantExpiresAt: string;
  /** The minted access-key TTL in seconds (~24h) shown on the screen. */
  keyTtlSeconds: number;
  /** Anti-CSRF nonce: rendered as the form's csrfToken and re-checked (double-submit) at the decision. */
  csrf: string;
  /** Unix seconds — the deadline by which the user must decide (the ticket is dead strictly after this). */
  exp: number;
}

/** A PKCE-loopback consent (`/authorize`): carries the OAuth request replayed into completeAuthorization. */
export interface PkceConsentTicket extends ConsentTicketBase {
  flow: "pkce_loopback";
  /** The parsed OAuth request — replayed into completeAuthorization (carries the PKCE challenge + state). */
  request: ConsentAuthRequest;
}

/** A device-code consent (`/device`): carries the user-code that targets the device-store decision. */
export interface DeviceConsentTicket extends ConsentTicketBase {
  flow: "device_code";
  /** The device user-code this approval decides (→ setDeviceDecision). */
  userCode: string;
}

/** The sealed contents of a consent ticket — discriminated on `flow`. */
export type ConsentTicketPayload = PkceConsentTicket | DeviceConsentTicket;

/**
 * Import raw key bytes as a non-extractable HMAC key for ticket signing. CONSENT_TICKET_KEY is a dedicated
 * 32-byte secret; reject any other length so a misconfigured/truncated key fails loud at construction
 * rather than silently signing tickets with a weak/mismatched key.
 */
export function importConsentTicketKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== TICKET_KEY_BYTES) {
    throw new Error(`CONSENT_TICKET_KEY must be ${TICKET_KEY_BYTES} bytes, got ${raw.length}`);
  }
  return importHmacKey(raw);
}

async function tag(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  // The cast bridges the node-lib Uint8Array vs the DOM WebCrypto BufferSource under apps/auth's DOM
  // tsconfig (the same crypto.subtle friction the db package hits — see the tsconfig-boundary note).
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>),
  );
  return sig.slice(0, HMAC_BYTES);
}

/** Seal a payload into an opaque, MAC-protected, expiring ticket. */
export async function signConsentTicket(
  payload: ConsentTicketPayload,
  key: CryptoKey,
): Promise<string> {
  const bytes = utf8Encoder.encode(JSON.stringify(payload));
  const mac = await tag(key, bytes);
  return `${bytesToB64url(bytes)}.${bytesToB64url(mac)}`;
}

/**
 * Verify + open a consent ticket. Returns the payload only if the MAC recomputes AND it has not expired
 * (exp is inclusive — valid through exp, dead strictly after). Any malformed/tampered/forged/expired
 * ticket returns null (never throws), so callers fail closed on a single null check.
 */
export async function verifyConsentTicket(
  ticket: string,
  key: CryptoKey,
  nowSeconds: number,
): Promise<ConsentTicketPayload | null> {
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
  let payload: ConsentTicketPayload;
  try {
    payload = JSON.parse(utf8Decoder.decode(bytes)) as ConsentTicketPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || nowSeconds > payload.exp) return null;
  return payload;
}

/**
 * Project a verified ticket into the C↔E ConsentRequest the screen renders. The requestId IS the ticket
 * string (echoed back with the decision); the csrfToken is the ticket's nonce. Display fields only — the
 * userId + the AuthRequest stay sealed in the ticket, never exposed to the page.
 */
export function consentRequestFromTicket(
  ticket: string,
  payload: ConsentTicketPayload,
): ConsentRequest {
  return {
    requestId: ticket,
    csrfToken: payload.csrf,
    flow: payload.flow,
    client: { id: payload.clientId, name: payload.clientName },
    ...(payload.device ? { device: payload.device } : {}),
    org: { id: payload.orgId, name: payload.orgName },
    origin: payload.origin,
    scopes: payload.scopes,
    audience: payload.audience,
    grantExpiresAt: payload.grantExpiresAt,
    keyTtlSeconds: payload.keyTtlSeconds,
  };
}
