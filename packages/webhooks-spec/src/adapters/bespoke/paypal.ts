// PayPal webhooks — RSASSA-PKCS1-v1_5/SHA-256 over the string
//   `PAYPAL-TRANSMISSION-ID | PAYPAL-TRANSMISSION-TIME | <webhookId> | crc32(rawBody)`
// (pipe-joined; crc32 is the UNSIGNED IEEE CRC-32 of the raw body as a decimal string). The public key is
// an X.509 certificate FETCHED from `PAYPAL-CERT-URL`; the registered "secret" is the operator's configured
// webhook id (from the PayPal dashboard). We host-pin the cert URL to PayPal's cert hosts (+ require the
// documented cert path), fetch + cache it (engine fetchKey, fail-soft), extract the SPKI, and verify.

import { b64ToBytes, crc32, utf8Decoder, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { pemToDer, verifyRsaPkcs1Sha256 } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { findHeader } from "../shared";
import { x509SpkiFromDer } from "../x509";

const SIG_HEADER = "paypal-transmission-sig";
const ID_HEADER = "paypal-transmission-id";
const TIME_HEADER = "paypal-transmission-time";
const CERT_URL_HEADER = "paypal-cert-url";
const CERT_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_CERT_HOSTS = ["api.paypal.com", "api.sandbox.paypal.com"];
const CERT_PATH_PREFIX = "/v1/notifications/certs/";

export function makePaypalAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.paypal;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const sigB64 = findHeader(input.headers, SIG_HEADER);
    const transmissionId = findHeader(input.headers, ID_HEADER);
    const transmissionTime = findHeader(input.headers, TIME_HEADER);
    const certUrl = findHeader(input.headers, CERT_URL_HEADER);
    for (const [value, header] of [
      [sigB64, SIG_HEADER],
      [transmissionId, ID_HEADER],
      [transmissionTime, TIME_HEADER],
      [certUrl, CERT_URL_HEADER],
    ] as const) {
      if (value === undefined) {
        return verificationFailed({ code: "MISSING_HEADER", header, scheme: "paypal" });
      }
    }
    const signature = b64ToBytes(sigB64!);
    if (signature === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not base64",
        scheme: "paypal",
      });
    }

    // Validate the message-supplied cert URL: PayPal cert host + the documented cert path. Fail closed on
    // anything else (the engine fetcher ALSO host-pins, but this rejects early with a clear diagnostic and
    // enforces the path the fetcher doesn't check).
    let parsedCertUrl: URL;
    try {
      parsedCertUrl = new URL(certUrl!);
    } catch {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }
    if (
      parsedCertUrl.protocol !== "https:" ||
      !ALLOWED_CERT_HOSTS.includes(parsedCertUrl.hostname) ||
      !parsedCertUrl.pathname.startsWith(CERT_PATH_PREFIX)
    ) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }

    if (input.secrets.length === 0) {
      return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    }
    if (input.fetchKey === undefined) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "paypal" });
    }

    const certBytes = await input.fetchKey({
      cacheKey: certUrl!, // the cert URL embeds the cert id; rotation = a new URL
      url: certUrl!,
      allowedHosts: ALLOWED_CERT_HOSTS,
      ttlSeconds: CERT_TTL_SECONDS,
    });
    if (certBytes === null) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "paypal" });
    }
    const certDer = pemToDer(utf8Decoder.decode(certBytes));
    const spki = certDer === null ? null : x509SpkiFromDer(certDer);
    if (spki === null) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "paypal" });
    }

    const crc = crc32(input.rawBody).toString();
    for (let i = 0; i < input.secrets.length; i++) {
      const webhookId = input.secrets[i]!;
      const message = utf8Encoder.encode(
        `${transmissionId}|${transmissionTime}|${webhookId}|${crc}`,
      );
      if (await verifyRsaPkcs1Sha256(spki, message, signature)) {
        return verificationOk(`secret_${i}`, "paypal");
      }
    }
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "paypal", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
