// MessageBird-JWT (the current "classic" MessageBird scheme) — a hand-written JWS adapter: the
// `MessageBird-Signature-JWT` header carries an HS256 JWT that doesn't HMAC the body directly; it
// authenticates the request via signed claims and binds the body + URL through `payload_hash` /
// `url_hash` (lowercase-hex SHA-256). Reproduces messagebird-go `signature_jwt`:
//
//   1. HS256-verify the JWT (key = the dashboard "Signing key", VERBATIM utf8 — never hex-decoded even
//      though it looks like 64 hex chars) — the A0b jws primitive does the JOSE mechanics + alg gate.
//   2. iss === "MessageBird" (a cheap cross-check; the signature is the real proof).
//   3. freshness: nbf/exp (Go SDK) — accept iat as the lower bound if nbf is absent (Node SDK).
//   4. url_hash === hex(SHA256(raw request URL, verbatim — not re-sorted)).  [present iff signed]
//   5. payload_hash === hex(SHA256(raw body)); OMITTED when the body is empty.
//
// (The new Bird Notifications platform uses a raw-HMAC scheme on a different header; that's a separate
// future mode. The legacy `MessageBird-Signature` raw-HMAC is deprecated in every SDK.)

import { bytesToHex, sha256, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { enforceJwtWindow, jwsFailureToResult, verifyCompactHs } from "../jws";
import { findHeader } from "../shared";

const SIGNATURE_HEADER = "messagebird-signature-jwt";
const ISSUER = "MessageBird";

/** lowercase-hex SHA-256 of the given bytes (MessageBird's url_hash / payload_hash encoding). */
async function sha256Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(data));
}

export function makeMessagebirdAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.messagebird;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const token = findHeader(input.headers, SIGNATURE_HEADER);
    if (token === undefined) {
      return verificationFailed({
        code: "MISSING_HEADER",
        header: SIGNATURE_HEADER,
        scheme: "messagebird",
      });
    }

    const jws = await verifyCompactHs(token, input.secrets);
    if (!jws.ok) return jwsFailureToResult(jws.reason, "messagebird");
    const { payload, secretIndex } = jws;

    // (2) issuer — require it present AND equal. The HS256 signature is the real proof (and the engine
    // scopes secrets per-provider), so this is defense-in-depth; requiring presence avoids a fail-open on
    // a stripped iss without rejecting any valid token (MessageBird always sends it).
    if (payload.iss !== ISSUER) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }

    // (3) freshness — exp (upper) + nbf/iat (lower) against the configured window (shared helper, NaN-now
    // guarded). exp/nbf stay OPTIONAL on purpose: MessageBird's Go SDK sends nbf+exp but the Node SDK sends
    // iat, so requiring exp would false-reject the iat variant — and the body/URL hash binding is the
    // integrity guarantee regardless. The 300s default tolerance is the engine's consistent skew posture.
    const stale = enforceJwtWindow(payload, toleranceSeconds, input.now);
    if (stale !== null) return stale;

    // (4) URL binding — present iff signed. We hash the request URL verbatim (the only URL we hold); a
    // non-canonical configured URL fails CLOSED, the documented Tier-2 URL-binding trade-off (ADR-0080).
    if (typeof payload.url_hash === "string") {
      if (input.requestUrl === undefined) {
        return verificationFailed({
          code: "MALFORMED_SIGNATURE",
          detail: "missing request url for url_hash",
          scheme: "messagebird",
        });
      }
      const urlHash = await sha256Hex(utf8Encoder.encode(input.requestUrl));
      if (urlHash !== payload.url_hash.toLowerCase()) {
        return verificationFailed({ code: "SIGNATURE_MISMATCH" });
      }
    }

    // (5) Body binding — payload_hash present iff body non-empty. A mismatch means the signed-for bytes
    // changed in transit (the hash is inside an authenticated token); an absent hash with a non-empty
    // body leaves the payload unbound, so reject that too.
    if (typeof payload.payload_hash === "string") {
      const bodyHash = await sha256Hex(input.rawBody);
      if (bodyHash !== payload.payload_hash.toLowerCase()) {
        return verificationFailed({ code: "PROXY_MUTATED_BYTES", confidence: "medium" });
      }
    } else if (input.rawBody.length > 0) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }

    return verificationOk(`secret_${secretIndex}`, "messagebird");
  }

  return { scheme: "messagebird", signatureHeader: SIGNATURE_HEADER, toleranceSeconds, verify };
}
