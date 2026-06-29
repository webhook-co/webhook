import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Encoder } from "../bytes";
import type { WebhookScheme } from "../scheme";
import { getAdapterForScheme } from "./registry";

// W2 — raw-body HMAC providers that sign with a NON-SHA256 digest (enabled by F2). Each KAT signs the
// raw body in the provider's real digest via raw crypto.subtle (an independent oracle), then asserts
// the config-derived adapter verifies it — so the digest selection (sha1 / sha512) is what's under test.
//  - vercel:   HMAC-SHA1,   `x-vercel-signature: <hex>`            (bare)
//  - intercom: HMAC-SHA1,   `x-hub-signature: sha1=<hex>`          (GitHub-style prefix)
//  - paystack: HMAC-SHA512, `x-paystack-signature: <hex>`         (bare)

const SECRET = "a-test-signing-secret";
const OTHER = "the-wrong-secret";
const BODY = '{"event":"test","id":"evt_w2"}';
const NOW = new Date(1790000000 * 1000);

async function signHex(hash: string, secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message))),
  );
}

interface Case {
  readonly slug: WebhookScheme;
  readonly sigHeader: string;
  readonly hash: "SHA-1" | "SHA-512";
  /** The signature header value for a given hex signature (adds any provider prefix). */
  readonly headerValue: (sig: string) => string;
}

const CASES: readonly Case[] = [
  {
    slug: "vercel",
    sigHeader: "x-vercel-signature",
    hash: "SHA-1",
    headerValue: (sig) => sig,
  },
  {
    slug: "intercom",
    sigHeader: "x-hub-signature",
    hash: "SHA-1",
    headerValue: (sig) => `sha1=${sig}`,
  },
  {
    slug: "paystack",
    sigHeader: "x-paystack-signature",
    hash: "SHA-512",
    headerValue: (sig) => sig,
  },
];

describe("W2 non-SHA256 raw-body providers", () => {
  for (const c of CASES) {
    describe(c.slug, () => {
      it(`exposes ${c.sigHeader} metadata`, () => {
        const adapter = getAdapterForScheme(c.slug)!;
        expect(adapter.scheme).toBe(c.slug);
        expect(adapter.signatureHeader).toBe(c.sigHeader);
      });

      it(`verifies a ${c.hash} signature over the raw body`, async () => {
        const sig = await signHex(c.hash, SECRET, BODY);
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [
            ["content-type", "application/json"],
            [c.sigHeader, c.headerValue(sig)],
          ],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: c.slug });
      });

      it("rejects a signature from the wrong secret", async () => {
        const sig = await signHex(c.hash, OTHER, BODY);
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[c.sigHeader, c.headerValue(sig)]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
      });
    });
  }
});
