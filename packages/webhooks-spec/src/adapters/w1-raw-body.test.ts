import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W1 batch 1 — raw-body HMAC-SHA256 providers (the signature is over the EXACT request body, no
// timestamp/framing). Self-consistent KATs per provider: sign the body with a test secret in the
// provider's encoding (+ optional value prefix) and assert its config-driven adapter verifies. The
// crypto itself is the audited verifyHmacCore (covered exhaustively elsewhere); these lock each
// provider's header name, encoding, and prefix.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const SECRET = "a-test-signing-secret";
const BODY = '{"event":"test","id":"evt_1"}';
const NOW = new Date("2026-06-29T00:00:00Z");

/** slug, signature header, encoding, optional value prefix. */
const RAW_BODY = [
  ["razorpay", "x-razorpay-signature", "hex", ""],
  ["sentry", "sentry-hook-signature", "hex", ""],
  ["linear", "linear-signature", "hex", ""],
  ["dropbox", "x-dropbox-signature", "hex", ""],
  ["checkout_com", "cko-signature", "hex", ""],
  ["lemon_squeezy", "x-signature", "hex", ""],
  ["coinbase_commerce", "x-cc-webhook-signature", "hex", ""],
  ["dwolla", "x-request-signature-sha-256", "hex", ""],
  ["gocardless", "webhook-signature", "hex", ""],
  ["notion", "x-notion-signature", "hex", "sha256="],
  ["meta", "x-hub-signature-256", "hex", "sha256="],
  ["woocommerce", "x-wc-webhook-signature", "base64", ""],
] as const;

async function sign(encoding: "hex" | "base64", secret: string, body: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(body));
  return encoding === "hex" ? bytesToHex(mac) : bytesToB64(mac);
}

describe("W1 batch 1 — raw-body HMAC providers", () => {
  for (const [slug, header, encoding, prefix] of RAW_BODY) {
    describe(slug, () => {
      it(`exposes ${header} metadata`, () => {
        const adapter = getAdapterForScheme(slug)!;
        expect(adapter.scheme).toBe(slug);
        expect(adapter.signatureHeader).toBe(header);
      });

      it(`verifies a ${encoding} HMAC over the raw body`, async () => {
        const sig = await sign(encoding, SECRET, BODY);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it("does not verify a signature made with a different secret", async () => {
        const sig = await sign(encoding, "attacker-secret", BODY);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
      });
    });
  }
});
