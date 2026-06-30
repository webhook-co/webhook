// Amazon SNS — the delivery mechanism for SES events and many AWS webhooks. The POST body is JSON; the
// signature is a base64 field IN the body (no signature header), an RSA signature over a canonical
// `Key\nValue\n` string of the present signable fields in a fixed order. SignatureVersion 1 = SHA-1,
// 2 = SHA-256. The public key is an X.509 cert FETCHED from the body's `SigningCertURL` (host-pinned to
// `sns.<region>.amazonaws.com`, path ending `.pem`). The registered "secret" is the operator's TopicArn,
// which binds a message to their topic.
//
// `SubscriptionConfirmation` / `UnsubscribeConfirmation` are SURFACE-ONLY: we verify the signature and
// capture the event, but never auto-GET the `SubscribeURL` (auto-confirming a message-supplied URL is an
// SSRF/abuse vector) — the operator confirms a subscription out of band.

import { b64ToBytes, utf8Decoder, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { pemToDer, verifyRsaPkcs1 } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { x509SpkiFromDer } from "../x509";

const CERT_TTL_SECONDS = 24 * 60 * 60;
// Host pin (anchored): sns.<region>.amazonaws.com (+ .cn). A substring check is the documented CVE-class bug.
const ALLOWED_CERT_HOST = /^sns\.[a-z0-9-]{3,}\.amazonaws\.com(\.cn)?$/;

// The signable keys, in order. A Notification omits SubscribeURL+Token; a (Un)SubscribeConfirmation
// includes them. Subject is optional everywhere. Only PRESENT string fields are emitted (AWS SDK `isset`).
const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const CONFIRMATION_KEYS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

/** Build SNS's canonical string: `Key\nValue\n` for each present signable key, in the fixed per-type order. */
function snsCanonical(message: Record<string, unknown>, type: string): string {
  const keys = type === "Notification" ? NOTIFICATION_KEYS : CONFIRMATION_KEYS;
  let out = "";
  for (const key of keys) {
    const value = message[key];
    if (typeof value === "string") out += `${key}\n${value}\n`;
  }
  return out;
}

export function makeAwsSnsAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.aws_sns;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(utf8Decoder.decode(input.rawBody));
      if (typeof parsed !== "object" || parsed === null) {
        return verificationFailed({
          code: "MALFORMED_SIGNATURE",
          detail: "body is not a JSON object",
          scheme: "aws_sns",
        });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "body is not JSON",
        scheme: "aws_sns",
      });
    }

    const type = body.Type;
    const signatureB64 = body.Signature;
    const signingCertUrl = body.SigningCertURL;
    const topicArn = body.TopicArn;
    if (
      typeof type !== "string" ||
      typeof signatureB64 !== "string" ||
      typeof signingCertUrl !== "string" ||
      typeof topicArn !== "string"
    ) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "missing SNS fields",
        scheme: "aws_sns",
      });
    }

    // TopicArn binds the message to the operator's registered topic.
    const index = input.secrets.indexOf(topicArn);
    if (index === -1) {
      return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    }

    const signature = b64ToBytes(signatureB64);
    if (signature === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not base64",
        scheme: "aws_sns",
      });
    }

    let certUrl: URL;
    try {
      certUrl = new URL(signingCertUrl);
    } catch {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }
    if (
      certUrl.protocol !== "https:" ||
      !ALLOWED_CERT_HOST.test(certUrl.hostname) ||
      !certUrl.pathname.endsWith(".pem")
    ) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }

    if (input.fetchKey === undefined) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "aws_sns" });
    }
    const certBytes = await input.fetchKey({
      cacheKey: signingCertUrl,
      url: signingCertUrl,
      allowedHosts: ALLOWED_CERT_HOST,
      ttlSeconds: CERT_TTL_SECONDS,
    });
    if (certBytes === null) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "aws_sns" });
    }
    const certDer = pemToDer(utf8Decoder.decode(certBytes));
    const spki = certDer === null ? null : x509SpkiFromDer(certDer);
    if (spki === null) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "aws_sns" });
    }

    const canonical = utf8Encoder.encode(snsCanonical(body, type));
    const hash = body.SignatureVersion === "2" ? "SHA-256" : "SHA-1"; // v1 (SHA-1) is still AWS's default
    if (await verifyRsaPkcs1(spki, canonical, signature, hash)) {
      return verificationOk(`secret_${index}`, "aws_sns");
    }
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  // No signature header — the signature is a body field; the F0 registered-provider gate runs this adapter
  // for a registered aws_sns endpoint regardless (signatureHeader "" skips the header-presence check).
  return { scheme: "aws_sns", signatureHeader: "", toleranceSeconds, verify };
}
