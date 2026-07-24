import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// Providers added in response to issue #788. Same shape as the S8 raw-body batch: the signature is
// over the EXACT request body, no timestamp or framing, key = the raw UTF-8 secret. Each is a
// one-line `rawBodyHmacConfig` row.
//
// SCHEMES DOC-VERIFIED AGAINST EACH PROVIDER'S OWN DOCUMENTATION (2026-07-24) — the hard requirement
// #788 asks contributors for, applied to ourselves:
//   checkr   — `X-Checkr-Signature`,  HMAC-SHA256 / hex, over the request body, no prefix.
//              https://docs.checkr.com/#section/Webhooks/Validating-webhooks
//   doppler  — `X-Doppler-Signature`, HMAC-SHA256 / hex, over the request body, `sha256=` prefix.
//              https://docs.doppler.com/docs/webhooks
//   sendbird — `X-Sendbird-Signature`, HMAC-SHA256 / hex, over the payload, no prefix; the key is the
//              MASTER API token (secondary tokens do not verify).
//              https://sendbird.com/docs/chat/platform-api/v3/webhook/webhook-overview
//
// DELIBERATELY NOT ADDED, and why — a guessed row turns "unsupported" into "your signature is
// invalid", which is a worse answer than not covering the provider (same reasoning as the S8 batch's
// deferred list):
//   figma      — verification is a shared `passcode` carried in the request BODY, not an HMAC
//                signature. If added it belongs in bespoke/token-auth, not here.
//   pipedrive  — authenticates webhooks with HTTP Basic, not a signature.
//   greenhouse — real HMAC-SHA256/hex, but the header is the bare `Signature`. Detection is
//                first-match on header presence, so that row would claim any unknown provider
//                sending a generic `Signature` header and report WRONG_SECRET instead of
//                UNSUPPORTED_SCHEME. Needs a detection story before it can land.
//   gusto, courier, statsig — could not reach primary documentation stating the algorithm and
//                encoding. Not guessed.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Sign INDEPENDENTLY via raw crypto.subtle — a true cross-check, not a re-run of the verify path's
// own key import. If both sides shared a helper, a bug in that helper would verify against itself.
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

const SECRET = "a-contributed-provider-signing-secret"; // gitleaks:allow — fabricated test fixture, not a credential
const BODY = '{"event":"webhook.test","id":"evt_788"}';
const NOW = new Date("2026-07-24T00:00:00Z");

/** slug, signature header, HMAC hash, signature encoding, required value prefix (empty = none). */
const CONTRIBUTED = [
  ["checkr", "x-checkr-signature", "SHA-256", "hex", ""],
  ["doppler", "x-doppler-signature", "SHA-256", "hex", "sha256="],
  ["sendbird", "x-sendbird-signature", "SHA-256", "hex", ""],
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

describe("#788 — contributed raw-body HMAC providers", () => {
  it("covers every provider this batch claims to add", () => {
    // Non-vacuous: a typo'd slug would otherwise silently shrink the table to nothing.
    expect(CONTRIBUTED.length).toBe(3);
  });

  for (const [slug, header, hash, encoding, prefix] of CONTRIBUTED) {
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
        const sig = await sign(hash, encoding, SECRET, BODY); // signed over BODY
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode('{"event":"webhook.test","id":"evt_TAMPERED"}'),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
      });

      it("is detected from its own signature header", async () => {
        const { detectScheme } = await import("./registry");
        expect(detectScheme([[header, "irrelevant"]])).toBe(slug);
      });
    });
  }

  // Doppler's `sha256=` prefix is REQUIRED, not cosmetic: a bare hex digest is a malformed signature
  // rather than a mismatch, so the failure names the real problem instead of sending someone to
  // rotate a secret that was never wrong.
  it("rejects a Doppler signature missing its required sha256= prefix", async () => {
    const sig = await sign("SHA-256", "hex", SECRET, BODY);
    const result = await getAdapterForScheme("doppler")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-doppler-signature", sig]], // no prefix
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
