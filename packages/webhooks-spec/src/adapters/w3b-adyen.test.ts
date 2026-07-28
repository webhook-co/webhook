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

  /**
   * Adyen BATCHES. `notificationItems` is an array and production traffic carries more than one
   * entry; each `NotificationRequestItem` has its own `hmacSignature`.
   *
   * Verifying only index 0 means items 1..N are neither verified nor rejected — a request with one
   * authentic item and any number of forged ones is reported `ok`, and the caller then processes
   * every item in it. That is a signature check that can be walked straight past by appending to an
   * array, which is the whole property the check exists to provide.
   */
  describe("batches — every item is verified, not just the first", () => {
    /** item[0] is the published gold vector; item[1] is authentic-shaped but signed by nobody. */
    const FORGED_SECOND = JSON.stringify({
      notificationItems: [
        JSON.parse(BODY).notificationItems[0],
        {
          NotificationRequestItem: {
            pspReference: "9999999999999999",
            merchantAccountCode: "TestMerchant",
            merchantReference: "ATTACKER-CREDIT-1",
            amount: { value: 500000, currency: "EUR" },
            eventCode: "AUTHORISATION",
            success: "true",
            additionalData: { hmacSignature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
          },
        },
      ],
    });

    it("rejects a batch whose first item is authentic and whose second is forged", async () => {
      const result = await getAdapterForScheme("adyen")!.verify({
        rawBody: utf8Encoder.encode(FORGED_SECOND),
        headers: [["content-type", "application/json"]],
        secrets: [ADYEN_EXAMPLE_HEX],
        now: new Date(1790000000 * 1000),
      });
      expect(result.ok, "a forged trailing item was accepted on the strength of item[0]").toBe(
        false,
      );
    });

    /**
     * The positive half. Without it the rule above could be satisfied by an adapter that simply
     * rejects every batch, which would be a different bug wearing the same green tick.
     *
     * Second item signed independently with the same published key, message
     * `8888888888888888::TestMerchant:TestPayment-2:2260:EUR:CAPTURE:true` (originalReference absent
     * → the empty middle field). Produced via node:crypto HMAC-SHA256, i.e. an oracle outside the
     * implementation under test.
     */
    const BOTH_AUTHENTIC = JSON.stringify({
      notificationItems: [
        JSON.parse(BODY).notificationItems[0],
        {
          NotificationRequestItem: {
            pspReference: "8888888888888888",
            merchantAccountCode: "TestMerchant",
            merchantReference: "TestPayment-2",
            amount: { value: 2260, currency: "EUR" },
            eventCode: "CAPTURE",
            success: "true",
            additionalData: { hmacSignature: "rxCpIouv7Oj8fEJfT3W0tQgH5YWbagEBg4tHp51xS1s=" },
          },
        },
      ],
    });

    it("accepts a batch in which every item verifies", async () => {
      const result = await getAdapterForScheme("adyen")!.verify({
        rawBody: utf8Encoder.encode(BOTH_AUTHENTIC),
        headers: [["content-type", "application/json"]],
        secrets: [ADYEN_EXAMPLE_HEX],
        now: new Date(1790000000 * 1000),
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "adyen" });
    });

    it("rejects a forged item in ANY position, not just the last", async () => {
      const forgedFirst = JSON.stringify({
        notificationItems: [
          JSON.parse(FORGED_SECOND).notificationItems[1],
          JSON.parse(BODY).notificationItems[0],
        ],
      });
      const result = await getAdapterForScheme("adyen")!.verify({
        rawBody: utf8Encoder.encode(forgedFirst),
        headers: [["content-type", "application/json"]],
        secrets: [ADYEN_EXAMPLE_HEX],
        now: new Date(1790000000 * 1000),
      });
      expect(result.ok).toBe(false);
    });

    /**
     * An empty array is not "nothing to check, therefore fine". There is no authentic content in it,
     * so reporting `ok` would be a pass over an empty set — the exact shape this codebase treats as a
     * guard defect everywhere else.
     */
    it("refuses an empty notificationItems array instead of passing vacuously", async () => {
      const empty = JSON.stringify({ notificationItems: [] });
      const result = await getAdapterForScheme("adyen")!.verify({
        rawBody: utf8Encoder.encode(empty),
        headers: [["content-type", "application/json"]],
        secrets: [ADYEN_EXAMPLE_HEX],
        now: new Date(1790000000 * 1000),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
    });

    /**
     * The key loop was rewritten to verify every item per candidate key, so rotation is a path that
     * changed. Retiring key first, live key second — the live one must still be found, and reported.
     */
    it("still finds the live key during rotation, across a whole batch", async () => {
      const result = await getAdapterForScheme("adyen")!.verify({
        rawBody: utf8Encoder.encode(BOTH_AUTHENTIC),
        headers: [["content-type", "application/json"]],
        secrets: [
          "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          ADYEN_EXAMPLE_HEX,
        ],
        now: new Date(1790000000 * 1000),
      });
      expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "adyen" });
    });

    it("refuses a batch where a later item carries no signature at all", async () => {
      const missingSig = JSON.stringify({
        notificationItems: [
          JSON.parse(BODY).notificationItems[0],
          { NotificationRequestItem: { pspReference: "x", additionalData: {} } },
        ],
      });
      const result = await getAdapterForScheme("adyen")!.verify({
        rawBody: utf8Encoder.encode(missingSig),
        headers: [["content-type", "application/json"]],
        secrets: [ADYEN_EXAMPLE_HEX],
        now: new Date(1790000000 * 1000),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
    });
  });
});
