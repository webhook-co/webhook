import { describe, expect, it } from "vitest";

import { hmacSha256, utf8Encoder } from "../bytes";
import { shopifyAdapter } from "./shopify";
import { MAX_VERIFIABLE_BODY_BYTES } from "./shared";

// base64-encode bytes (standard alphabet, padded). Test-local: production only needs DECODE.
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Shopify has NO official numeric test vector, so this is a self-consistent KAT: the body is
// signed with HMAC-SHA256(secret, rawBody) base64 — exactly the spec construction — and the
// adapter must verify it. The base64 verification machinery itself is byte-anchored by the
// Standard Webhooks published vector (both go through verifyHmacBase64).
// https://shopify.dev/docs/apps/build/webhooks/subscribe/https
const SECRET = "shpss_shopify_app_client_secret";
const ROTATED = "shpss_rotated_client_secret";
const BODY = '{"id":820982911946154508,"note":"hello"}';
const NOW = new Date("2026-06-13T00:00:00Z");

async function signShopify(body: string, secret: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(body));
  return bytesToB64(mac);
}

function headers(sig: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/json"],
    ["X-Shopify-Hmac-Sha256", sig],
  ];
}

describe("shopifyAdapter", () => {
  it("exposes scheme metadata", () => {
    expect(shopifyAdapter.scheme).toBe("shopify");
    expect(shopifyAdapter.signatureHeader).toBe("x-shopify-hmac-sha256");
  });

  it("verifies a known-answer base64 signature over the verbatim body", async () => {
    const sig = await signShopify(BODY, SECRET);
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "shopify" });
  });

  it("accepts a rotated secret", async () => {
    const sig = await signShopify(BODY, ROTATED);
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "shopify" });
  });

  it("ignores the (absent) timestamp — an arbitrarily old now must not fail temporally", async () => {
    const sig = await signShopify(BODY, SECRET);
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: new Date("2030-01-01T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
  });

  it("diagnoses a missing signature header", async () => {
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "x-shopify-hmac-sha256", scheme: "shopify" },
    });
  });

  it("flags WRONG_SECRET when shape is right but no secret matches", async () => {
    const sig = await signShopify(BODY, "totally_unrelated_secret");
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("WRONG_SECRET");
      if (result.reason.code === "WRONG_SECRET") expect(result.reason.confidence).toBe("low");
    }
  });

  it("flags RAW_BODY_MODIFIED when the JSON was re-serialized in transit", async () => {
    const compact = JSON.stringify({ id: 1, note: "hi" });
    const sig = await signShopify(compact, SECRET);
    const prettied = JSON.stringify({ id: 1, note: "hi" }, null, 2);
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(prettied),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("RAW_BODY_MODIFIED");
      if (result.reason.code === "RAW_BODY_MODIFIED") {
        expect(result.reason.evidence).toBe("reencoded_json");
      }
    }
  });

  it("diagnoses a malformed base64 signature", async () => {
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("@@@not-base64@@@"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses an empty signature as malformed (not a mismatch)", async () => {
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(""),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a base64 signature with embedded whitespace as malformed", async () => {
    // atob would forgivingly strip the space; the strict alphabet guard must reject it.
    const sig = await signShopify(BODY, SECRET);
    const folded = `${sig.slice(0, 10)} ${sig.slice(10)}`;
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(folded),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports NO_MATCHING_KEY when no secrets are registered", async () => {
    const sig = await signShopify(BODY, SECRET);
    const result = await shopifyAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("diagnoses an oversized body without attempting the HMAC", async () => {
    const huge = new Uint8Array(MAX_VERIFIABLE_BODY_BYTES + 1);
    const result = await shopifyAdapter.verify({
      rawBody: huge,
      headers: headers(bytesToB64(new Uint8Array(32))),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
