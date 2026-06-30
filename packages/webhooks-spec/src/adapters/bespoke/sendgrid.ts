// SendGrid (Twilio Email Event Webhook) — ECDSA P-256 / SHA-256 over `timestamp + rawBody`. Headers
// `X-Twilio-Email-Event-Webhook-Signature` (base64 DER ECDSA sig) + `…-Timestamp`. The registered "secret"
// is the dashboard "Verification Key" — base64 of the SPKI DER public key. The DER signature is converted
// to IEEE-P1363 raw r||s for crypto.subtle. The timestamp is bound into the signed message but no replay
// window is enforced (signature is the authenticity guarantee; downstream dedupe handles replay).

import { b64ToBytes, concatBytes, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { derEcdsaSigToRaw, verifyEcdsaP256Sha256 } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { findHeader } from "../shared";

const SIG_HEADER = "x-twilio-email-event-webhook-signature";
const TS_HEADER = "x-twilio-email-event-webhook-timestamp";

export function makeSendgridAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.sendgrid;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const sigB64 = findHeader(input.headers, SIG_HEADER);
    if (sigB64 === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: SIG_HEADER, scheme: "sendgrid" });
    }
    const ts = findHeader(input.headers, TS_HEADER);
    if (ts === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: TS_HEADER, scheme: "sendgrid" });
    }
    const der = b64ToBytes(sigB64);
    const rawSig = der === null ? null : derEcdsaSigToRaw(der);
    if (rawSig === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not a DER ECDSA P-256 signature",
        scheme: "sendgrid",
      });
    }

    const message = concatBytes(utf8Encoder.encode(ts), input.rawBody);

    let sawUsableKey = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const spki = b64ToBytes(input.secrets[i]!);
      if (spki === null || spki.length === 0) continue; // not a usable base64 SPKI key
      sawUsableKey = true;
      if (await verifyEcdsaP256Sha256(spki, message, rawSig)) {
        return verificationOk(`secret_${i}`, "sendgrid");
      }
    }
    if (!sawUsableKey) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "sendgrid", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
