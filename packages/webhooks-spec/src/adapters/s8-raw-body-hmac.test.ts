import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage — raw-body HMAC providers (the signature is over the EXACT request body, no
// timestamp/framing; key = the raw UTF-8 secret). Each is a one-line `rawBodyHmacConfig` row.
// Self-consistent KATs per provider sign the body with a test secret in the provider's digest +
// encoding (+ optional value prefix) and assert its config-driven adapter verifies; the crypto engine
// itself is covered exhaustively elsewhere. Schemes doc-verified per provider (research 2026-07-01):
//   sha256/hex  : pusher · chargify · launchdarkly · modern_treasury
//   sha256/b64  : quickbooks (intuit-signature)
//   sha1/hex + `sha1hash=` prefix : autodesk_aps
//   sha1/base64 : mongodb_atlas (x-mms-signature)
// Deferred (NOT here): gusto (encoding undocumented), pinwheel (timestamp-framed `v2:{ts}:{body}`,
// not raw-body), formstack (algorithm/encoding undocumented) — a guessed scheme would mis-verify.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Sign INDEPENDENTLY via raw crypto.subtle (a true cross-check, not the verify path's own key import).
async function signMac(hash: string, secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message)));
}

const SECRET = "an-s8-raw-body-signing-secret"; // gitleaks:allow — fabricated test fixture, not a credential
const BODY = '{"event":"webhook.test","id":"evt_s8"}';
const NOW = new Date("2026-07-01T00:00:00Z");

/** slug, signature header, HMAC hash, signature encoding, optional required value prefix. */
const RAW_HMAC = [
  ["pusher", "x-pusher-signature", "SHA-256", "hex", ""],
  ["quickbooks", "intuit-signature", "SHA-256", "base64", ""],
  ["chargify", "x-chargify-webhook-signature-hmac-sha-256", "SHA-256", "hex", ""],
  ["launchdarkly", "x-ld-signature", "SHA-256", "hex", ""],
  ["modern_treasury", "x-signature", "SHA-256", "hex", ""],
  ["autodesk_aps", "x-adsk-signature", "SHA-1", "hex", "sha1hash="],
  ["mongodb_atlas", "x-mms-signature", "SHA-1", "base64", ""],
] as const;

async function sign(
  hash: string,
  encoding: "hex" | "base64",
  secret: string,
  body: string,
): Promise<string> {
  const mac = await signMac(hash, secret, body);
  return encoding === "hex" ? bytesToHex(mac) : bytesToB64(mac);
}

describe("S8 coverage — raw-body HMAC providers", () => {
  for (const [slug, header, hash, encoding, prefix] of RAW_HMAC) {
    describe(slug, () => {
      it(`exposes ${header} metadata`, () => {
        const adapter = getAdapterForScheme(slug)!;
        expect(adapter.scheme).toBe(slug);
        expect(adapter.signatureHeader).toBe(header);
      });

      it(`verifies a ${hash}/${encoding} HMAC over the raw body${prefix ? ` (prefixed \`${prefix}\`)` : ""}`, async () => {
        const sig = await sign(hash, encoding, SECRET, BODY);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it("does not verify a signature made with a different secret", async () => {
        const sig = await sign(hash, encoding, "attacker-secret", BODY);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
      });

      it("does not verify a tampered body", async () => {
        const sig = await sign(hash, encoding, SECRET, BODY); // over BODY
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode('{"event":"webhook.test","id":"evt_TAMPERED"}'),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
      });
    });
  }
});
