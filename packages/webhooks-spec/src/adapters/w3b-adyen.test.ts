import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W3b — Adyen standard (payment) webhooks. The signature lives INSIDE the JSON body at
// notificationItems[0].NotificationRequestItem.additionalData.hmacSignature (base64). The signed message
// is 8 fields of that item joined by a plain colon (NO escaping, NO sorting — that's the legacy HPP path,
// not this one), absent fields = empty string. Key = the Customer-Area HMAC key HEX-DECODED. HMAC-SHA256.
// The KAT is Adyen's published worked example, independently reproduced via openssl — an external oracle.

// Adyen's PUBLIC documentation example HMAC key (not a real secret). gitleaks:allow
const ADYEN_EXAMPLE_HEX = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
// data-to-sign = `7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true`
// (originalReference absent → the empty middle field → `::`).
const BODY = JSON.stringify({
  notificationItems: [
    {
      NotificationRequestItem: {
        pspReference: "7914073381342284",
        merchantAccountCode: "TestMerchant",
        merchantReference: "TestPayment-1407325143704",
        amount: { value: 1130, currency: "EUR" },
        eventCode: "AUTHORISATION",
        success: "true",
        additionalData: { hmacSignature: "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=" },
      },
    },
  ],
});

describe("W3b adyen (sig-in-body JSON, colon-join, hex key) — published gold vector", () => {
  it("exposes adyen metadata", () => {
    const a = getAdapterForScheme("adyen")!;
    expect(a.scheme).toBe("adyen");
  });

  it("verifies the published worked example (openssl-reproduced)", async () => {
    const result = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [ADYEN_EXAMPLE_HEX],
      now: new Date(1790000000 * 1000),
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "adyen" });
  });

  it("rejects the wrong key", async () => {
    const result = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: ["00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
  });

  it("is MALFORMED when the body carries no hmacSignature", async () => {
    const noSig = JSON.stringify({
      notificationItems: [{ NotificationRequestItem: { pspReference: "x", additionalData: {} } }],
    });
    const result = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(noSig),
      headers: [["content-type", "application/json"]],
      secrets: [ADYEN_EXAMPLE_HEX],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
