import type { AuthContext } from "@webhook-co/contract";
import {
  b64urlToBytes,
  bytesToB64url,
  importHmacKey,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "@webhook-co/shared";

// A8c — per-request principal isolation for the mcp resource server.
//
// The MCP streamable-HTTP transport (McpAgent.serve) routes the WebhookMcp Durable Object PURELY by the
// `Mcp-Session-Id`, and `this.props` (the principal) is set ONCE at session init and not refreshed on warm
// requests. So a session id reused by a DIFFERENT principal would route to the FIRST principal's DO and read
// THEIR org. The library exposes no DO-name hook and no per-request principal to the DO, so the fix lives at
// the resource-server EDGE: wrap the server-assigned session id in an HMAC-signed envelope that BINDS it to
// the initializing principal, and on every request require the current bearer's principal to match. A
// different principal presenting the id fails to unbind it (→ no base id → the request is rejected before it
// can reach the DO). Tamper/forgery is impossible without the key (the env is signed). Codec mirrors the
// cursor / consent-ticket envelope: `<base64url(json)>.<base64url(mac)>`.

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag (matches the cursor / consent-ticket codec).
const SESSION_KEY_BYTES = 32; // a dedicated 32-byte secret (MCP_SESSION_KEY), never reused from another key.

/**
 * The current envelope version. `unbindSessionId` rejects any envelope whose `v` is missing or != this, so
 * a future codec change is a clean break: pre-versioning / mismatched envelopes fail to unbind (→ null) and
 * the in-flight session cleanly re-initializes. Bump this whenever the envelope shape or semantics change.
 */
export const SESSION_ENVELOPE_VERSION = 1;

/**
 * The max session lifetime (24h, in seconds). `bindSessionId` stamps `exp = nowSeconds + this`, and
 * `unbindSessionId` rejects an envelope once `nowSeconds > exp` — so a leaked/stolen session id can't be
 * replayed indefinitely; after the ceiling the client must re-initialize (the same fail-closed re-init path
 * as a version bump). The window is generous enough not to interrupt a normal interactive MCP session.
 */
export const SESSION_TTL_SECONDS = 86_400;

/** The signed envelope: version + the library's base session id + the bound principal digest + expiry. */
interface SessionEnvelope {
  /** The envelope version — must equal SESSION_ENVELOPE_VERSION to unbind (else the session re-initializes). */
  v: number;
  /** The base (library-assigned) session id the McpAgent transport routes the DO by. */
  b: string;
  /** The initializing principal's digest — the current request's principal must equal this. */
  p: string;
  /** Unix seconds — the max session lifetime ceiling; the envelope is dead strictly after this (now > exp). */
  exp: number;
}

/**
 * Import raw key bytes as a non-extractable HMAC key for session binding. MCP_SESSION_KEY is a dedicated
 * 32-byte secret; reject any other length so a misconfigured/truncated key fails loud at construction.
 */
export async function importSessionKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== SESSION_KEY_BYTES) {
    throw new Error(`MCP_SESSION_KEY must be ${SESSION_KEY_BYTES} bytes, got ${raw.length}`);
  }
  return importHmacKey(raw);
}

/**
 * A stable, non-secret digest of the PRINCIPAL identity (org + optional user) — NOT the token or its
 * scopes, so a refreshed/re-scoped token for the same identity keeps the same session. An org-scoped api
 * key (no userId) is a distinct principal from a user in the same org. Goes inside the signed envelope,
 * so it needn't be keyed; equality is all the binding check needs.
 *
 * The identity is hashed as canonical JSON so the org/user boundary is UNAMBIGUOUS — JSON quotes + escapes
 * both fields, so no `orgId`/`userId` value can be crafted to collide with a different (org, user) pair (a
 * raw delimiter like a separator byte would rely on that byte never appearing in an id; this doesn't).
 */
export async function principalDigest(ctx: AuthContext): Promise<string> {
  const bytes = utf8Encoder.encode(JSON.stringify({ o: ctx.orgId, u: ctx.userId ?? null }));
  const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return bytesToB64url(new Uint8Array(hash));
}

async function tag(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  // The cast bridges the node-lib Uint8Array vs the DOM WebCrypto BufferSource type (the same crypto.subtle
  // friction db/auth hit — see the tsconfig-boundary note); no runtime effect.
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>),
  );
  return sig.slice(0, HMAC_BYTES);
}

/**
 * Wrap a base session id + principal digest into the signed, opaque session id handed to the client. The
 * envelope is stamped with the current version and an expiry `nowSeconds + SESSION_TTL_SECONDS` (the max
 * session lifetime). `nowSeconds` is the injected clock (Unix seconds) — the same shape the consent-ticket /
 * device codecs take — so the codec stays pure and the expiry is deterministically testable.
 */
export async function bindSessionId(
  key: CryptoKey,
  baseId: string,
  digest: string,
  nowSeconds: number,
): Promise<string> {
  const env: SessionEnvelope = {
    v: SESSION_ENVELOPE_VERSION,
    b: baseId,
    p: digest,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  const bytes = utf8Encoder.encode(JSON.stringify(env));
  const mac = await tag(key, bytes);
  return `${bytesToB64url(bytes)}.${bytesToB64url(mac)}`;
}

/**
 * Verify a wrapped session id and return its base session id ONLY when the MAC recomputes AND the envelope
 * is the current version AND it has not expired (`nowSeconds <= exp`, inclusive) AND the bound principal
 * equals `digest` (the current request's principal). Any malformed / tampered / forged / wrong-key id, a
 * stale-version or expired envelope, or a valid id presented by a DIFFERENT principal, returns null (never
 * throws) — the cases are indistinguishable to the caller (no oracle), so a stolen session id is useless to
 * anyone but its owner, and only for as long as its session lives. `nowSeconds` is the injected clock (Unix
 * seconds). An OLD envelope without `v`/`exp` fails closed → the in-flight session cleanly re-initializes.
 */
export async function unbindSessionId(
  key: CryptoKey,
  wrapped: string,
  digest: string,
  nowSeconds: number,
): Promise<string | null> {
  const dot = wrapped.indexOf(".");
  if (dot <= 0 || dot === wrapped.length - 1) return null;
  let bytes: Uint8Array;
  let presentedMac: Uint8Array;
  try {
    bytes = b64urlToBytes(wrapped.slice(0, dot));
    presentedMac = b64urlToBytes(wrapped.slice(dot + 1));
  } catch {
    return null;
  }
  const expectedMac = await tag(key, bytes);
  if (!timingSafeEqual(presentedMac, expectedMac)) return null;
  let env: SessionEnvelope;
  try {
    env = JSON.parse(utf8Decoder.decode(bytes)) as SessionEnvelope;
  } catch {
    return null;
  }
  // Version + expiry gates: a missing/mismatched version or a missing/past expiry fails closed (→ null), so
  // pre-versioning envelopes and leaked-but-stale ids cleanly re-initialize rather than being honored.
  if (env.v !== SESSION_ENVELOPE_VERSION) return null;
  if (typeof env.exp !== "number" || nowSeconds > env.exp) return null;
  if (typeof env.b !== "string" || env.b === "" || typeof env.p !== "string") return null;
  // The bound principal must equal the presenting principal — the heart of the isolation guarantee.
  if (!constantTimeStringEq(env.p, digest)) return null;
  return env.b;
}

/** Constant-time string compare for the digest check (both are our own base64url digests). */
function constantTimeStringEq(a: string, b: string): boolean {
  const ab = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
