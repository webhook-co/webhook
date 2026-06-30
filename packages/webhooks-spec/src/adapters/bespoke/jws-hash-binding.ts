// A small factory for the simplest HS256-JWT providers: those whose token is `{ iss, <bodyHashClaim> }`
// where the body is bound by a single lowercase-hex SHA-256 claim and there is no URL binding and no
// provider-enforced expiry (Netlify `sha256`; Vonage `payload_hash`). It verifies the JWS (A0b jws
// primitive, alg-gated), checks the issuer, then recomputes SHA-256 of the raw body and compares.
//
// Providers with richer binding (MessageBird: url_hash + nbf/exp; Monday: aud + no body hash; Jira: qsh)
// stay hand-written — this factory deliberately covers ONLY the iss-plus-one-body-hash shape.

import { bytesToHex, sha256 } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import type { Provider } from "../config";
import { jwsFailureToResult, verifyCompactHs } from "../jws";
import { findHeader } from "../shared";

export interface HashBindingJwsConfig {
  readonly slug: Provider;
  /** The header carrying the JWT (e.g. `x-webhook-signature`, or `authorization` for a Bearer token). */
  readonly header: string;
  /** An auth-scheme prefix to strip from the header value if present (e.g. `"Bearer "`), case-insensitive. */
  readonly bearerPrefix?: string;
  /** The required `iss` claim. */
  readonly issuer: string;
  /** The claim holding lowercase-hex SHA-256 of the raw body (Netlify `sha256`, Vonage `payload_hash`). */
  readonly bodyHashClaim: string;
  readonly toleranceSeconds: number;
}

export function makeHashBindingJwsAdapter(config: HashBindingJwsConfig): VerifyAdapter {
  const { slug, header, bearerPrefix, issuer, bodyHashClaim, toleranceSeconds } = config;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    let value = findHeader(input.headers, header);
    if (value === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header, scheme: slug });
    }
    if (bearerPrefix !== undefined && value.toLowerCase().startsWith(bearerPrefix.toLowerCase())) {
      value = value.slice(bearerPrefix.length).trim();
    }

    const jws = await verifyCompactHs(value, input.secrets);
    if (!jws.ok) return jwsFailureToResult(jws.reason, slug);
    const { payload, secretIndex } = jws;

    // Issuer — require present AND equal (defense-in-depth; Netlify/Vonage always send iss, so requiring
    // it closes the fail-open on a stripped claim without rejecting any valid token).
    if (payload.iss !== issuer) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }

    // Body binding — the signed hex-SHA-256 claim must match the body we received. An absent claim leaves
    // the body unbound (reject); a mismatch means the bytes changed after the provider signed them.
    const claim = payload[bodyHashClaim];
    if (typeof claim !== "string") {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }
    const bodyHash = bytesToHex(await sha256(input.rawBody));
    if (bodyHash !== claim.toLowerCase()) {
      return verificationFailed({ code: "PROXY_MUTATED_BYTES", confidence: "medium" });
    }

    return verificationOk(`secret_${secretIndex}`, slug);
  }

  return { scheme: slug, signatureHeader: header, toleranceSeconds, verify };
}
