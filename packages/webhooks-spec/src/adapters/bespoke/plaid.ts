// Plaid webhooks — an ES256 JWT in the `Plaid-Verification` header; the body is bound by a
// `request_body_sha256` claim (hex SHA-256 of the raw body). The verification key is Plaid's EC public key,
// fetched by `kid` from an AUTHENTICATED endpoint (`POST /webhook_verification_key/get` with the operator's
// Plaid client_id + secret) — the only remote-fetch provider needing credentials, so the registered "secret"
// is a JSON blob `{"environment":"production"|"sandbox","client_id":"…","secret":"…"}`. We pin alg ES256,
// verify the JWS, then recompute SHA-256(body) and compare to the (now-authenticated) claim, then check iat
// freshness. The fetch is host-pinned + cached + fail-soft (KEY_FETCH_FAILED).

import { bytesToHex, sha256, utf8Decoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { verifyEcdsaP256Sha256Jwk } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { enforceJwtWindow, parseCompactJws } from "../jws";
import { findHeader } from "../shared";

const SIG_HEADER = "plaid-verification";
const KEY_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_ENVIRONMENTS = new Set(["production", "sandbox"]);

interface PlaidCreds {
  readonly environment: string;
  readonly clientId: string;
  readonly secret: string;
}

/** Parse the registered JSON secret into Plaid API creds. null on any malformation / unknown environment. */
function parseCreds(raw: string): PlaidCreds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.environment !== "string" ||
    !ALLOWED_ENVIRONMENTS.has(o.environment) ||
    typeof o.client_id !== "string" ||
    typeof o.secret !== "string"
  ) {
    return null;
  }
  return { environment: o.environment, clientId: o.client_id, secret: o.secret };
}

/** Extract the EC public JWK from the `/webhook_verification_key/get` response bytes (`{ key: <JWK> }`). */
function parsePlaidKey(bytes: Uint8Array): JsonWebKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return null;
  }
  const key = (parsed as { key?: unknown } | null)?.key;
  if (typeof key !== "object" || key === null) return null;
  if ((key as Record<string, unknown>).kty !== "EC") return null;
  return key as JsonWebKey;
}

export function makePlaidAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.plaid;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const token = findHeader(input.headers, SIG_HEADER);
    if (token === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: SIG_HEADER, scheme: "plaid" });
    }
    const parsed = parseCompactJws(token);
    if (parsed === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "not a compact JWS",
        scheme: "plaid",
      });
    }
    if (parsed.header.alg !== "ES256") {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "unsupported JWT alg (expected ES256)",
        scheme: "plaid",
      });
    }
    const kid = parsed.header.kid;
    if (typeof kid !== "string") {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "missing kid",
        scheme: "plaid",
      });
    }

    if (input.fetchKey === undefined) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "plaid" });
    }

    let sawUsableSecret = false;
    let fetchFailed = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const creds = parseCreds(input.secrets[i]!);
      if (creds === null) continue;
      sawUsableSecret = true;
      const host = `${creds.environment}.plaid.com`;
      const keyBytes = await input.fetchKey({
        cacheKey: `plaid:${creds.environment}:${kid}`,
        url: `https://${host}/webhook_verification_key/get`,
        allowedHosts: [host],
        method: "POST",
        body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, key_id: kid }),
        headers: [["content-type", "application/json"]],
        ttlSeconds: KEY_TTL_SECONDS,
      });
      if (keyBytes === null) {
        fetchFailed = true;
        continue;
      }
      const jwk = parsePlaidKey(keyBytes);
      if (jwk === null) {
        fetchFailed = true;
        continue;
      }
      if (!(await verifyEcdsaP256Sha256Jwk(jwk, parsed.signingInput, parsed.signature))) {
        continue; // wrong env/key for this kid — try the next registered secret
      }

      // Signature authentic → the request_body_sha256 claim is trustworthy; bind the body to it.
      const claim = parsed.payload.request_body_sha256;
      const bodyHash = bytesToHex(await sha256(input.rawBody));
      if (typeof claim !== "string" || bodyHash !== claim.toLowerCase()) {
        return verificationFailed({ code: "PROXY_MUTATED_BYTES", confidence: "medium" });
      }
      const stale = enforceJwtWindow(parsed.payload, toleranceSeconds, input.now);
      if (stale !== null) return stale;
      return verificationOk(`secret_${i}`, "plaid");
    }

    if (!sawUsableSecret) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    if (fetchFailed) return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "plaid" });
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "plaid", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
