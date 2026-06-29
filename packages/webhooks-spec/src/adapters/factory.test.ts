import { describe, expect, it } from "vitest";

import { bytesToHex, concatBytes, hmacSha256, utf8Encoder } from "../bytes";
import { GITHUB_CONFIG, SHOPIFY_CONFIG, type HmacProviderConfig } from "./config";
import { makeHmacAdapter } from "./factory";

// base64-encode bytes (standard alphabet, padded). Test-local: production only needs DECODE.
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const NOW = new Date("2026-06-29T00:00:00Z");
const SECRET = "factory_secret";
const ROTATED = "factory_rotated";
const BODY = '{"hello":"world"}';

function header(name: string, value: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/json"],
    [name, value],
  ];
}

describe("makeHmacAdapter", () => {
  it("exposes config-derived metadata (scheme, signatureHeader, toleranceSeconds)", () => {
    const adapter = makeHmacAdapter(GITHUB_CONFIG);
    expect(adapter.scheme).toBe("github");
    expect(adapter.signatureHeader).toBe("x-hub-signature-256");
    expect(adapter.toleranceSeconds).toBe(300);
  });

  it("verifies a hex signature with a required prefix (GitHub recipe)", async () => {
    const mac = await hmacSha256(utf8Encoder.encode(SECRET), utf8Encoder.encode(BODY));
    const adapter = makeHmacAdapter(GITHUB_CONFIG);
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: header("X-Hub-Signature-256", `sha256=${bytesToHex(mac)}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "github" });
  });

  it("diagnoses a missing required prefix as MALFORMED_SIGNATURE", async () => {
    const adapter = makeHmacAdapter(GITHUB_CONFIG);
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: header("X-Hub-Signature-256", "deadbeef"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("verifies a base64 signature with no prefix (Shopify recipe), newest-first rotation", async () => {
    const mac = await hmacSha256(utf8Encoder.encode(ROTATED), utf8Encoder.encode(BODY));
    const adapter = makeHmacAdapter(SHOPIFY_CONFIG);
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: header("X-Shopify-Hmac-Sha256", bytesToB64(mac)),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "shopify" });
  });

  it("reports MISSING_HEADER when the signature header is absent", async () => {
    const adapter = makeHmacAdapter(GITHUB_CONFIG);
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "x-hub-signature-256", scheme: "github" },
    });
  });

  it("builds the signed message from ordered literal+body parts", async () => {
    // A synthetic recipe proving the part-concatenation: HMAC over "PRE." + rawBody, hex.
    const config: HmacProviderConfig = {
      slug: "slack",
      signatureHeader: "x-test-signature",
      encoding: "hex",
      message: [{ kind: "literal", value: "PRE." }, { kind: "body" }],
      toleranceSeconds: 300,
    };
    const signed = concatBytes(utf8Encoder.encode("PRE."), utf8Encoder.encode(BODY));
    const mac = await hmacSha256(utf8Encoder.encode(SECRET), signed);
    const adapter = makeHmacAdapter(config);
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: header("x-test-signature", bytesToHex(mac)),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "slack" });
  });
});
