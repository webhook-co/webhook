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

  /**
   * `hexToBytes("")` returns a ZERO-BYTE array, not null, and Web Crypto throws `DataError` on a
   * zero-length HMAC key. So an empty secret does not fall through the "not hex, skip it" branch — it
   * reaches `importHmacKey` and throws out of an adapter that promises never to. The mixed case is the
   * damaging one: one misconfigured empty secret alongside the live key turns every Adyen webhook from
   * verified into an exception. Mirrors the standard-webhooks regression test for the same class.
   */
  it("does not throw on an empty secret, and still finds the live key beside one", async () => {
    const onlyEmpty = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [""],
      now: new Date(1790000000 * 1000),
    });
    expect(onlyEmpty.ok).toBe(false);
    if (!onlyEmpty.ok) expect(onlyEmpty.reason.code).toBe("NO_MATCHING_KEY");

    const mixed = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: ["", ADYEN_EXAMPLE_HEX],
      now: new Date(1790000000 * 1000),
    });
    expect(mixed).toEqual({ ok: true, keyId: "secret_1", scheme: "adyen" });
  });

  /**
   * A well-formed signature that simply did not match is WRONG_SECRET — the same code every sibling
   * adapter returns, and the one the docs promise. Flattening it to SIGNATURE_MISMATCH would lose the
   * most actionable thing the diagnosis tells a user.
   */
  it("reports WRONG_SECRET, not a generic mismatch, for a well-formed signature under a bad key", async () => {
    const result = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: ["00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  /**
   * Collapsing "absent" and "present but an object/array" both to "" lets a forged item build the SAME
   * signed message as an authentic notification that carried no `amount` at all — so one real Adyen
   * signature covers both readings. A consumer doing `Number(item.amount.value)` then reads 999999,
   * because JS coerces a 1-element array. Adyen never sends a non-scalar in a signed position, so
   * rejecting it costs nothing and closes the class.
   */
  it("refuses a non-scalar in a signed field instead of treating it as absent", async () => {
    const nonScalarAmount = JSON.stringify({
      notificationItems: [
        {
          NotificationRequestItem: {
            pspReference: "P2",
            merchantAccountCode: "ACCT",
            merchantReference: "R",
            amount: { value: ["999999"], currency: ["EUR"] },
            eventCode: "REPORT_AVAILABLE",
            success: "true",
            additionalData: { hmacSignature: "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=" },
          },
        },
      ],
    });
    const result = await getAdapterForScheme("adyen")!.verify({
      rawBody: utf8Encoder.encode(nonScalarAmount),
      headers: [["content-type", "application/json"]],
      secrets: [ADYEN_EXAMPLE_HEX],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
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
