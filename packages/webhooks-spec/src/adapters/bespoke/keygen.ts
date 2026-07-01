// Keygen (keygen.sh) webhook signatures — Ed25519 over an HTTP Message Signatures / draft-cavage signing
// string (NOT a raw-body HMAC, so it can't be a config row). The `Keygen-Signature` header is a
// comma-separated cavage parameter set: `keyid="<account>",algorithm="ed25519",signature="<base64>",
// headers="(request-target) host date digest"`. The signed string is reconstructed line-by-line from the
// `headers` list:
//   (request-target): <method-lowercase> <path+query>
//   host: <host header>
//   date: <date header>
//   digest: sha-256=<base64(sha256(rawBody))>
// The `digest` line is RECOMPUTED from the received body (never trusting the incoming Digest header), so a
// tampered body changes the signing string and fails Ed25519 verification — binding the body. The
// registered secret is the account's Ed25519 public key (hex). Ed25519's default is Keygen's default; other
// signatureAlgorithms (ecdsa-p256 / rsa-pss / rsa) are not handled here (MALFORMED). Verified against
// self-generated vectors (keygen.test.ts); the scheme is byte-exact per Keygen's Signatures docs.

import { b64ToBytes, bytesToB64, hexToBytes, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { verifyEd25519 } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { findHeader } from "../shared";

const SIG_HEADER = "keygen-signature";

/** Parse a draft-cavage HTTP-Signatures header into its `key="value"` params. null if none parse. */
function parseCavageParams(headerValue: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(headerValue)) !== null) out[m[1]!] = m[2]!;
  return Object.keys(out).length === 0 ? null : out;
}

async function sha256Base64(body: Uint8Array): Promise<string> {
  return bytesToB64(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

export function makeKeygenAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.keygen;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const headerValue = findHeader(input.headers, SIG_HEADER);
    if (headerValue === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: SIG_HEADER, scheme: "keygen" });
    }
    const malformed = (detail: string): VerificationResult =>
      verificationFailed({ code: "MALFORMED_SIGNATURE", detail, scheme: "keygen" });

    const params = parseCavageParams(headerValue);
    if (params === null || params.signature === undefined || params.headers === undefined) {
      return malformed("keygen-signature is not a cavage keyid/algorithm/signature/headers header");
    }
    // Ed25519 is Keygen's default; only ed25519 is handled here (other algorithms → MALFORMED, not a
    // silent pass). An absent algorithm param is treated as the ed25519 default.
    if (params.algorithm !== undefined && params.algorithm !== "ed25519") {
      return malformed(`unsupported algorithm "${params.algorithm}" (only ed25519 is supported)`);
    }
    const sigBytes = b64ToBytes(params.signature);
    if (sigBytes === null) return malformed("signature is not base64");

    // Reconstruct the signing string from the ordered `headers` list.
    const tokens = params.headers.split(" ").filter((t) => t.length > 0);
    if (tokens.length === 0) return malformed("empty headers list");
    const lines: string[] = [];
    for (const token of tokens) {
      // (String-literal dispatch on the header token — a switch keeps eslint-plugin-security from
      // misreading these parse-time comparisons as secret-equality timing attacks.)
      switch (token) {
        case "(request-target)": {
          if (input.method === undefined || input.requestUrl === undefined) {
            return malformed("missing request method/url for (request-target)");
          }
          let target: string;
          try {
            const u = new URL(input.requestUrl);
            target = `${input.method.toLowerCase()} ${u.pathname}${u.search}`;
          } catch {
            return malformed("request url is not a valid URL");
          }
          lines.push(`(request-target): ${target}`);
          break;
        }
        case "digest": {
          lines.push(`digest: sha-256=${await sha256Base64(input.rawBody)}`);
          break;
        }
        default: {
          const value = findHeader(input.headers, token);
          if (value === undefined) return malformed(`signed header "${token}" is absent`);
          lines.push(`${token}: ${value}`);
        }
      }
    }
    const message = utf8Encoder.encode(lines.join("\n"));

    let sawUsableSecret = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const publicKey = hexToBytes(input.secrets[i]!);
      if (publicKey === null) continue; // non-hex secrets (e.g. verify-token blobs) are skipped
      sawUsableSecret = true;
      if (await verifyEd25519(publicKey, message, sigBytes)) {
        return verificationOk(`secret_${i}`, "keygen");
      }
    }
    if (!sawUsableSecret) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "keygen", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
