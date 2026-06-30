// Wise (TransferWise) — RSASSA-PKCS1-v1_5 / SHA-256 over the RAW request body. Header `X-Signature-SHA256`
// (base64 RSA signature; the legacy unsuffixed `X-Signature` is SHA-1 — ignored). The registered "secret"
// is Wise's PUBLISHED public key (separate sandbox + production keys), pasted as PEM (a bare base64 SPKI is
// also accepted). No signed timestamp; Wise documents replay protection via X-Delivery-Id / sent_at, which
// downstream dedupe handles.

import { b64ToBytes } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { pemToDer, verifyRsaPkcs1Sha256 } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { findHeader } from "../shared";

const SIG_HEADER = "x-signature-sha256";

export function makeWiseAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.wise;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const sigB64 = findHeader(input.headers, SIG_HEADER);
    if (sigB64 === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: SIG_HEADER, scheme: "wise" });
    }
    const signature = b64ToBytes(sigB64);
    if (signature === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not base64",
        scheme: "wise",
      });
    }

    let sawUsableKey = false;
    for (let i = 0; i < input.secrets.length; i++) {
      // The registered key is Wise's PEM public key; fall back to a bare-base64 SPKI paste.
      const spki = pemToDer(input.secrets[i]!) ?? b64ToBytes(input.secrets[i]!);
      if (spki === null || spki.length === 0) continue;
      sawUsableKey = true;
      if (await verifyRsaPkcs1Sha256(spki, input.rawBody, signature)) {
        return verificationOk(`secret_${i}`, "wise");
      }
    }
    if (!sawUsableKey) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "wise", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
