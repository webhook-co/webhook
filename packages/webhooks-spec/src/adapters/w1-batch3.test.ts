import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import type { WebhookScheme } from "../scheme";
import { getAdapterForScheme } from "./registry";

// W1 batch 3 — timestamped HMAC-SHA256 providers (the signed message embeds the timestamp + sometimes
// a message-id/nonce header). Self-consistent KATs per provider that build the exact signed string,
// plus a stale-timestamp case that exercises each provider's replay window.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const SECRET = "a-test-signing-secret";
const BODY = '{"event":"test","id":"evt_3"}';
const TS = 1790000000;
const NONCE = "sinch-nonce-abc123"; // x-sinch-webhook-signature-nonce
const NOW = new Date(TS * 1000 + 1000); // 1s after the signed timestamp — inside every window

type HeaderPairs = ReadonlyArray<readonly [string, string]>;
interface Case {
  readonly slug: WebhookScheme;
  readonly sigHeader: string;
  readonly enc: "hex" | "base64";
  /** The non-content-type headers (signature + timestamp + any id/nonce) for a given ts + signature. */
  readonly headers: (ts: string, sig: string) => HeaderPairs;
  /** The exact string the provider HMACs. */
  readonly msg: (ts: string, body: string) => string;
}

const CASES: readonly Case[] = [
  {
    slug: "calendly",
    sigHeader: "calendly-webhook-signature",
    enc: "hex",
    headers: (ts, sig) => [["calendly-webhook-signature", `t=${ts},v1=${sig}`]],
    msg: (ts, body) => `${ts}.${body}`,
  },
  {
    slug: "zoom",
    sigHeader: "x-zm-signature",
    enc: "hex",
    headers: (ts, sig) => [
      ["x-zm-request-timestamp", ts],
      ["x-zm-signature", `v0=${sig}`],
    ],
    msg: (ts, body) => `v0:${ts}:${body}`,
  },
  {
    slug: "customerio",
    sigHeader: "x-cio-signature",
    enc: "hex",
    headers: (ts, sig) => [
      ["x-cio-timestamp", ts],
      ["x-cio-signature", sig],
    ],
    msg: (ts, body) => `v0:${ts}:${body}`,
  },
  {
    slug: "sinch",
    sigHeader: "x-sinch-webhook-signature",
    enc: "base64",
    headers: (ts, sig) => [
      ["x-sinch-webhook-signature-nonce", NONCE],
      ["x-sinch-webhook-signature-timestamp", ts],
      ["x-sinch-webhook-signature", sig],
    ],
    msg: (ts, body) => `${body}.${NONCE}.${ts}`,
  },
];

async function signEnc(enc: "hex" | "base64", secret: string, signed: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(signed));
  return enc === "hex" ? bytesToHex(mac) : bytesToB64(mac);
}

describe("W1 batch 3 — timestamped HMAC providers", () => {
  for (const c of CASES) {
    describe(c.slug, () => {
      it(`exposes ${c.sigHeader} metadata`, () => {
        const adapter = getAdapterForScheme(c.slug)!;
        expect(adapter.scheme).toBe(c.slug);
        expect(adapter.signatureHeader).toBe(c.sigHeader);
      });

      it("verifies a correctly-signed event", async () => {
        const sig = await signEnc(c.enc, SECRET, c.msg(String(TS), BODY));
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [["content-type", "application/json"], ...c.headers(String(TS), sig)],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: c.slug });
      });

      it("rejects a stale timestamp (replay window)", async () => {
        const stale = String(TS - 100_000); // far outside every provider's window
        const sig = await signEnc(c.enc, SECRET, c.msg(stale, BODY));
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [["content-type", "application/json"], ...c.headers(stale, sig)],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
      });
    });
  }
});
