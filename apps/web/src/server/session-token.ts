import "server-only";

import type { Session } from "./session";

/**
 * The app. session cookie value: a self-contained, HMAC-SHA256-signed token carrying the session
 * principal — `base64url(payload).base64url(HMAC(secret, base64url(payload)))`. The principal comes
 * from the trusted A-SX backchannel exchange (auth.→app.), so app. is stateless: the signed cookie
 * IS the session, with no server-side store. HMAC-SHA256 over Web Crypto matches the repo's token
 * convention (the session-exchange ticket + the audit chain), so we don't add a JWT dependency.
 *
 * `image` may be null; `iat`/`exp` are unix seconds. Verification is constant-time and fails closed
 * (returns null) on any mismatch, expiry, or malformed input — the gate treats that as "no session".
 */

interface SessionTokenPayload {
  readonly sub: string; // userId
  readonly org: string; // orgId
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly iat: number;
  readonly exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Length-independent constant-time compare — no early exit reveals where two HMACs first differ. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  // Lengths are equal and i < length, so both elements are defined (noUncheckedIndexedAccess can't see it).
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Sign the session principal into a cookie token valid for `ttlSeconds`. */
export async function signSessionToken(
  session: Session,
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionTokenPayload = {
    sub: session.userId,
    org: session.orgId,
    name: session.user.name,
    email: session.user.email,
    image: session.user.image,
    iat,
    exp: iat + ttlSeconds,
  };
  const body = base64urlFromBytes(encoder.encode(JSON.stringify(payload)));
  const signature = base64urlFromBytes(await hmac(secret, body));
  return `${body}.${signature}`;
}

/** Verify + decode a cookie token. Returns the principal, or null on any failure (fail closed). */
export async function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<Session | null> {
  const dot = token.indexOf(".");
  // Need a non-empty body and a non-empty signature, and exactly one separator.
  if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let provided: Uint8Array;
  let expected: Uint8Array;
  try {
    provided = bytesFromBase64url(providedSig);
    expected = await hmac(secret, body);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: Partial<SessionTokenPayload>;
  try {
    payload = JSON.parse(decoder.decode(bytesFromBase64url(body))) as Partial<SessionTokenPayload>;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (typeof payload.org !== "string" || !payload.org) return null;

  return {
    userId: payload.sub,
    orgId: payload.org,
    user: {
      name: typeof payload.name === "string" ? payload.name : "",
      email: typeof payload.email === "string" ? payload.email : "",
      image: typeof payload.image === "string" ? payload.image : null,
    },
  };
}
