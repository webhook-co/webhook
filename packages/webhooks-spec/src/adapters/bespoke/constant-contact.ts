// Constant Contact V3 webhooks — the `X-CTCT-WEBHOOK-SIG` header is a DETACHED (RFC 7515 + RFC 7797) RS256
// JWS: `<b64url(protectedHeader)>..<b64url(signature)>` with an EMPTY payload segment. The protected header
// is `{alg:"RS256", ts:<unix>, b64:false, crit:["b64"]}`; `b64:false` means the payload is NOT
// base64url-encoded — the signing input is `ASCII(b64url(header)) + "." + rawBody` (RFC 7797). The signing
// key comes from Constant Contact's PUBLIC JWKS (developer.constantcontact.com), which carries NO `kid`, so
// every RSA signing key is tried. There is no per-endpoint secret — CC signs with its own account key, so a
// registered `constant_contact` secret is only an enable-marker (its value is ignored). The JWKS fetch is
// host-pinned + fail-soft (KEY_FETCH_FAILED). Like eBay, this is unit-verified against self-generated
// vectors (constant-contact.test.ts) but NOT yet validated against a live Constant Contact webhook.

import { b64urlToBytes, concatBytes, utf8Decoder, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { verifyRsaPkcs1Sha256Jwk } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { findHeader } from "../shared";

const SIG_HEADER = "x-ctct-webhook-sig";
const JWKS_URL = "https://developer.constantcontact.com/.well-known/jwks.json";
const JWKS_HOST = "developer.constantcontact.com";
const JWKS_TTL_SECONDS = 3600;

interface DetachedJws {
  readonly headerB64: string;
  readonly header: Record<string, unknown>;
  readonly signature: Uint8Array;
}

/** Parse a detached (RFC 7797) compact JWS `<b64url(header)>..<b64url(sig)>` — the payload segment is empty. */
function parseDetachedJws(value: string): DetachedJws | null {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[1] !== "") return null; // detached ⇒ empty middle segment
  const headerBytes = b64urlToBytes(parts[0]!);
  if (headerBytes === null) return null;
  let header: unknown;
  try {
    header = JSON.parse(utf8Decoder.decode(headerBytes));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  const signature = b64urlToBytes(parts[2]!);
  if (signature === null) return null;
  return { headerB64: parts[0]!, header: header as Record<string, unknown>, signature };
}

/**
 * Enforce Constant Contact's `ts` replay window. `ts` lives in the SIGNED protected header (a forger can't
 * back-date it), so this only ever rejects a stale-but-genuine replay — mirroring the HMAC/JWT adapters
 * that enforce their signed timestamp. A non-numeric `ts` is not enforceable (returns null, no false reject).
 */
function enforceCtctWindow(
  ts: unknown,
  toleranceSeconds: number,
  now?: Date,
): VerificationResult | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const nowMs = now?.getTime() ?? Date.now();
  const nowSec = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
  const skew = nowSec - ts;
  if (skew > toleranceSeconds) {
    return verificationFailed({ code: "TIMESTAMP_TOO_OLD", skewSeconds: skew, toleranceSeconds });
  }
  if (skew < -toleranceSeconds) {
    return verificationFailed({ code: "TIMESTAMP_IN_FUTURE", skewSeconds: skew, toleranceSeconds });
  }
  return null;
}

/** Collect every RSA signing JWK from raw JWKS bytes (CC's header has no `kid`, so all are candidates). */
function rsaSigningJwks(jwksBytes: Uint8Array): JsonWebKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(jwksBytes));
  } catch {
    return [];
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  const out: JsonWebKey[] = [];
  for (const candidate of keys) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const k = candidate as Record<string, unknown>;
    if (k.kty === "RSA" && (k.use === "sig" || k.use === undefined))
      out.push(candidate as JsonWebKey);
  }
  return out;
}

export function makeConstantContactAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.constant_contact;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const headerValue = findHeader(input.headers, SIG_HEADER);
    if (headerValue === undefined) {
      return verificationFailed({
        code: "MISSING_HEADER",
        header: SIG_HEADER,
        scheme: "constant_contact",
      });
    }
    const malformed = (detail: string): VerificationResult =>
      verificationFailed({ code: "MALFORMED_SIGNATURE", detail, scheme: "constant_contact" });

    const jws = parseDetachedJws(headerValue);
    if (jws === null) return malformed("x-ctct-webhook-sig is not a detached compact JWS");
    if (jws.header.alg !== "RS256") return malformed("unsupported alg (expected RS256)");
    // RFC 7797 unencoded payload: `b64` must be false AND listed in `crit`.
    if (jws.header.b64 !== false)
      return malformed("expected b64:false (RFC 7797 unencoded payload)");
    // RFC 7515 §4.1.11: reject a JWS whose `crit` lists any extension we don't understand. We only
    // understand `b64`, so every entry must be exactly "b64" (and there must be at least one).
    const crit = jws.header.crit;
    if (!Array.isArray(crit) || crit.length === 0 || !crit.every((c) => c === "b64"))
      return malformed("crit must be exactly [b64]");

    // A registered constant_contact secret is only an enable-marker (CC signs with its own account key from
    // a fixed public JWKS; there is no per-endpoint secret). Require at least one so a verified result means
    // the operator opted this endpoint into Constant Contact verification.
    if (input.secrets.length === 0)
      return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    if (input.fetchKey === undefined) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "constant_contact" });
    }

    // RFC 7797 signing input: ASCII(b64url(header)) + "." + the raw (unencoded) body bytes.
    const message = concatBytes(utf8Encoder.encode(`${jws.headerB64}.`), input.rawBody);

    const jwksBytes = await input.fetchKey({
      cacheKey: "constant_contact:jwks",
      url: JWKS_URL,
      allowedHosts: [JWKS_HOST],
      ttlSeconds: JWKS_TTL_SECONDS,
    });
    if (jwksBytes === null) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "constant_contact" });
    }

    const jwks = rsaSigningJwks(jwksBytes);
    for (const jwk of jwks) {
      if (await verifyRsaPkcs1Sha256Jwk(jwk, message, jws.signature)) {
        // Signature valid → enforce the signed `ts` replay window before accepting.
        const stale = enforceCtctWindow(jws.header.ts, toleranceSeconds, input.now);
        if (stale !== null) return stale;
        return verificationOk("secret_0", "constant_contact");
      }
    }
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "constant_contact", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
