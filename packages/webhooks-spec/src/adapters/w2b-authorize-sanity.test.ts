import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W2b — the two W2 providers that each need a small engine knob beyond F2's digest/encoding:
//  - authorize_net: HMAC-SHA512/hex over the raw body, header `X-ANET-Signature: sha512=<HEX>`, but the
//    KEY is the account "Signature Key" HEX-DECODED to bytes (confirmed against Authorize.Net's official
//    PHP `hex2bin($signatureKey)` + Java `hexStringToByteArray` SDK samples) — a new `hex` keyDerivation.
//  - sanity: HMAC-SHA256 base64url over `${t}.${body}`, header `sanity-webhook-signature: t=<ms>,v1=<sig>`,
//    timestamp in MILLISECONDS, and the provider enforces NO replay window — a new `enforceReplayWindow`
//    off. Verified against @sanity/webhook's published gold test vectors (the strongest possible check).

describe("W2b authorize_net (hex-decoded signature key)", () => {
  // A 128-hex-char Signature Key (64 bytes), as Authorize.Net issues. A deliberately-fake, low-entropy
  // fixture (not a real secret); registered verbatim as the secret, the adapter hex-decodes it to the
  // HMAC key — signing with the utf8 string would NOT match.
  const ANET_SIGNING_HEX = "0123456789abcdef".repeat(8); // gitleaks:allow — fake 128-hex fixture
  const BODY = '{"notificationId":"abc","eventType":"net.authorize.payment.authcapture.created"}';

  async function anetSign(keyHex: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(keyHex)!,
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(body)));
    return bytesToHex(mac).toUpperCase(); // Authorize.Net sends uppercase hex
  }

  it("exposes x-anet-signature metadata", () => {
    const adapter = getAdapterForScheme("authorize_net")!;
    expect(adapter.scheme).toBe("authorize_net");
    expect(adapter.signatureHeader).toBe("x-anet-signature");
  });

  it("verifies a sha512 signature whose key is the hex-decoded Signature Key", async () => {
    const sig = await anetSign(ANET_SIGNING_HEX, BODY);
    const result = await getAdapterForScheme("authorize_net")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["content-type", "application/json"],
        ["x-anet-signature", `sha512=${sig}`],
      ],
      secrets: [ANET_SIGNING_HEX],
      now: new Date(1790000000 * 1000),
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "authorize_net" });
  });

  it("rejects when the key is treated as utf8 instead of hex-decoded", async () => {
    // Sign with the hex-DECODED key (correct), but register a DIFFERENT key → must not match.
    const sig = await anetSign("aa".repeat(32), BODY);
    const result = await getAdapterForScheme("authorize_net")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-anet-signature", `sha512=${sig}`]],
      secrets: [ANET_SIGNING_HEX],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });
});

describe("W2b sanity (base64url, ms-timestamp, no replay window) — published gold vectors", () => {
  // From @sanity/webhook test/signature.test.ts. The signed message is `${t}.${body}`.
  const VECTORS = [
    {
      secret: "test",
      body: '{"_id":"resume"}',
      header: "t=1633519811129,v1=tLa470fx7qkLLEcMOcEUFuBbRSkGujyskxrNXcoh0N0",
    },
    {
      secret: "try-me",
      body: '{"title":"GROQ-Hooks are neat"}',
      header: "t=1633518820676,v1=e7C9h2sfbFfc4V7TEz7PSOp4IoNzl0UdVsBV-1wgdeA",
    },
  ] as const;

  // Far in the future relative to the 2021 vectors: proves the replay window is NOT enforced (a 300s
  // window would reject these as TIMESTAMP_TOO_OLD).
  const NOW = new Date("2026-06-29T00:00:00Z");

  it("exposes sanity-webhook-signature metadata", () => {
    const adapter = getAdapterForScheme("sanity")!;
    expect(adapter.scheme).toBe("sanity");
    expect(adapter.signatureHeader).toBe("sanity-webhook-signature");
  });

  for (const v of VECTORS) {
    it(`verifies the published vector for secret "${v.secret}"`, async () => {
      const result = await getAdapterForScheme("sanity")!.verify({
        rawBody: utf8Encoder.encode(v.body),
        headers: [
          ["content-type", "application/json"],
          ["sanity-webhook-signature", v.header],
        ],
        secrets: [v.secret],
        now: NOW,
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "sanity" });
    });
  }

  it("rejects the published vector under the wrong secret", async () => {
    const result = await getAdapterForScheme("sanity")!.verify({
      rawBody: utf8Encoder.encode(VECTORS[0].body),
      headers: [["sanity-webhook-signature", VECTORS[0].header]],
      secrets: ["not-the-secret"],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });
});
