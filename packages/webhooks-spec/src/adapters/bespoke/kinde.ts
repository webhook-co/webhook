// Kinde webhooks — the request BODY IS an RS256 JWT (content-type application/jwt); there is NO signature
// header. We parse the JWS, require alg RS256, bind the token's `iss` to a REGISTERED Kinde issuer (the
// operator's domain — the "secret" here), fetch THAT issuer's JWKS (host-pinned to the registered issuer's
// host, never a token-supplied host), find the `kid`'s RSA key, and verify the RS256 signature over the
// token. The signed payload IS the event, so verifying the JWS verifies the body. The key fetch is
// fail-soft (KEY_FETCH_FAILED — the event is captured unverified, never dropped).

import { utf8Decoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { verifyRsaPkcs1Sha256Jwk } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { parseCompactJws } from "../jws";

const JWKS_TTL_SECONDS = 3600;

/** Strip trailing slashes so `https://x.kinde.com/` and `https://x.kinde.com` compare equal. */
function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/** Find an RSA signing JWK by kid in raw JWKS bytes. null on any parse problem / no match. */
function findRsaJwk(jwksBytes: Uint8Array, kid: string): JsonWebKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(jwksBytes));
  } catch {
    return null;
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return null;
  for (const candidate of keys) {
    if (typeof candidate !== "object" || candidate === null) continue;
    // Read JWK fields via a loose record (workers-types' JsonWebKey doesn't declare `kid`); cast to
    // JsonWebKey only for importKey at the use site.
    const k = candidate as Record<string, unknown>;
    if (k.kid === kid && k.kty === "RSA" && (k.use === "sig" || k.use === undefined)) {
      return candidate as JsonWebKey;
    }
  }
  return null;
}

export function makeKindeAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.kinde;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const parsed = parseCompactJws(utf8Decoder.decode(input.rawBody));
    if (parsed === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "body is not a compact JWS",
        scheme: "kinde",
      });
    }
    if (parsed.header.alg !== "RS256") {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "unsupported JWT alg (expected RS256)",
        scheme: "kinde",
      });
    }
    const kid = parsed.header.kid;
    const iss = parsed.payload.iss;
    if (typeof kid !== "string" || typeof iss !== "string") {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "missing kid/iss",
        scheme: "kinde",
      });
    }

    // Bind iss to a registered issuer (operator config). The JWKS host pin comes from THAT registered
    // issuer, so a forged iss can't redirect the fetch.
    const index = input.secrets.findIndex((s) => normalizeIssuer(s) === normalizeIssuer(iss));
    if (index === -1) {
      return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    }
    const issuer = normalizeIssuer(input.secrets[index]!);
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    }

    if (input.fetchKey === undefined) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "kinde" });
    }
    const jwksBytes = await input.fetchKey({
      cacheKey: `kinde:${issuer}:jwks`,
      url: `${issuer}/.well-known/jwks.json`,
      allowedHosts: [issuerUrl.host],
      ttlSeconds: JWKS_TTL_SECONDS,
    });
    if (jwksBytes === null) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "kinde" });
    }

    const jwk = findRsaJwk(jwksBytes, kid);
    if (jwk === null) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" }); // kid not in the issuer's JWKS
    }
    if (await verifyRsaPkcs1Sha256Jwk(jwk, parsed.signingInput, parsed.signature)) {
      return verificationOk(`secret_${index}`, "kinde");
    }
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  // No signature header — the body IS the JWT; the F0 registered-provider gate runs this adapter for a
  // registered kinde endpoint regardless (it skips the header-presence check when signatureHeader is "").
  return { scheme: "kinde", signatureHeader: "", toleranceSeconds, verify };
}
