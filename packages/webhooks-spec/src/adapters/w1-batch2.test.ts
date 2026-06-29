import { describe, expect, it } from "vitest";

import { b64ToBytes, bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W1 batch 2 — raw-body HMAC-SHA256 providers with a value prefix (sha256=/v1=/hmac-sha256=), CSV
// multi-signature lists (circleci/pagerduty), and a base64-decoded key (airtable). Self-consistent
// KATs per provider locking each header name, encoding, value prefix, and key derivation.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const UTF8_SECRET = "a-test-signing-secret";
const B64_SECRET = bytesToB64(utf8Encoder.encode("airtable-mac-secret-32bytes-pad!")); // a base64 secret
const BODY = '{"event":"test","id":"evt_2"}';
const NOW = new Date("2026-06-29T00:00:00Z");

/** slug, signature header, encoding, value prefix (""=none), key mode. */
const CASES = [
  { slug: "bitbucket", header: "x-hub-signature", enc: "hex", prefix: "sha256=", key: "utf8" },
  { slug: "atlassian_jira", header: "x-hub-signature", enc: "hex", prefix: "sha256=", key: "utf8" },
  {
    slug: "x",
    header: "x-twitter-webhooks-signature",
    enc: "base64",
    prefix: "sha256=",
    key: "utf8",
  },
  { slug: "clickup", header: "x-signature", enc: "hex", prefix: "", key: "utf8" },
  { slug: "npm", header: "x-npm-signature", enc: "hex", prefix: "sha256=", key: "utf8" },
  { slug: "heroku", header: "heroku-webhook-hmac-sha256", enc: "base64", prefix: "", key: "utf8" },
  { slug: "dub", header: "dub-signature", enc: "hex", prefix: "", key: "utf8" },
  { slug: "cal_com", header: "x-cal-signature-256", enc: "hex", prefix: "", key: "utf8" },
  { slug: "asana", header: "x-hook-signature", enc: "hex", prefix: "", key: "utf8" },
  { slug: "circleci", header: "circleci-signature", enc: "hex", prefix: "v1=", key: "utf8" },
  { slug: "pagerduty", header: "x-pagerduty-signature", enc: "hex", prefix: "v1=", key: "utf8" },
  {
    slug: "airtable",
    header: "x-airtable-content-mac",
    enc: "hex",
    prefix: "hmac-sha256=",
    key: "base64",
  },
] as const;

async function sign(
  enc: "hex" | "base64",
  keyMode: "utf8" | "base64",
  secret: string,
  body: string,
): Promise<string> {
  const keyBytes = keyMode === "base64" ? b64ToBytes(secret)! : utf8Encoder.encode(secret);
  const mac = await hmacSha256(keyBytes, utf8Encoder.encode(body));
  return enc === "hex" ? bytesToHex(mac) : bytesToB64(mac);
}

describe("W1 batch 2 — raw-body / CSV / base64-key HMAC providers", () => {
  for (const { slug, header, enc, prefix, key } of CASES) {
    const secret = key === "base64" ? B64_SECRET : UTF8_SECRET;
    describe(slug, () => {
      it(`exposes ${header} metadata`, () => {
        const adapter = getAdapterForScheme(slug)!;
        expect(adapter.scheme).toBe(slug);
        expect(adapter.signatureHeader).toBe(header);
      });

      it(`verifies a ${enc} HMAC (${key} key)`, async () => {
        const sig = await sign(enc, key, secret, BODY);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [secret],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it("does not verify a signature made with a different secret", async () => {
        const wrong =
          key === "base64"
            ? bytesToB64(utf8Encoder.encode("wrong-airtable-secret-32bytes!!!"))
            : "attacker";
        const sig = await sign(enc, key, wrong, BODY);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, `${prefix}${sig}`]],
          secrets: [secret],
          now: NOW,
        });
        expect(result.ok).toBe(false);
      });
    });
  }
});
