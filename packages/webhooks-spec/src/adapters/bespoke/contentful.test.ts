import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Contentful bespoke adapter. No published vector exists, so this is a self-consistent KAT built in the
// EXACT canonical-string format of @contentful/node-apps-toolkit `signRequest` (doc/SDK-confirmed):
//   canonical = METHOD\nPATH\nHEADERS_SECTION\nBODY ; HEADERS_SECTION = signed headers `key:value`
//   (lowercased/trimmed, sorted asc by key) joined by ";". HMAC-SHA256, hex, 64-char utf8 secret, 30s TTL.

const SECRET = "a".repeat(64); // Contentful secrets are exactly 64 chars (used verbatim as the utf8 key)
const PATH = "/whep_abc123";
const URL = `https://wbhk.my${PATH}`;
const BODY = '{"sys":{"type":"Entry"},"fields":{"title":"hi"}}';
const NOW_MS = 1790000000000;

// Build Contentful's canonical string the way its SDK does, then HMAC it.
async function signContentful(opts: {
  method: string;
  path: string;
  signedHeaders: ReadonlyArray<readonly [string, string]>; // [name, value], pre-trimmed
  body: string;
}): Promise<string> {
  const pairs = [...opts.signedHeaders]
    .map(([k, v]) => [k.toLowerCase().trim(), v.trim()] as const)
    .sort(([a], [b]) => (a > b ? 1 : -1));
  const headersSection = pairs.map(([k, v]) => `${k}:${v}`).join(";");
  const canonical = `${opts.method}\n${opts.path}\n${headersSection}\n${opts.body}`;
  return bytesToHex(await hmacSha256(utf8Encoder.encode(SECRET), utf8Encoder.encode(canonical)));
}

describe("contentful bespoke (dynamic canonical request)", () => {
  // The request's signed headers (x-contentful-signed-headers lists these names; timestamp + the list
  // header itself are always among them).
  const signedHeaderNames =
    "x-contentful-timestamp,x-contentful-signed-headers,x-contentful-space-id";
  const requestHeaders: ReadonlyArray<readonly [string, string]> = [
    ["x-contentful-timestamp", String(NOW_MS)],
    ["x-contentful-signed-headers", signedHeaderNames],
    ["x-contentful-space-id", "spc_42"],
  ];

  it("exposes x-contentful-signature metadata", () => {
    const a = getAdapterForScheme("contentful")!;
    expect(a.scheme).toBe("contentful");
    expect(a.signatureHeader).toBe("x-contentful-signature");
  });

  it("verifies a correctly-signed canonical request", async () => {
    const sig = await signContentful({
      method: "POST",
      path: PATH,
      signedHeaders: requestHeaders,
      body: BODY,
    });
    const result = await getAdapterForScheme("contentful")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [...requestHeaders, ["x-contentful-signature", sig]],
      secrets: [SECRET],
      requestUrl: URL,
      method: "POST",
      now: new Date(NOW_MS + 2000), // 2s later — inside the 30s TTL
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "contentful" });
  });

  it("rejects a request older than the 30s TTL", async () => {
    const sig = await signContentful({
      method: "POST",
      path: PATH,
      signedHeaders: requestHeaders,
      body: BODY,
    });
    const result = await getAdapterForScheme("contentful")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [...requestHeaders, ["x-contentful-signature", sig]],
      secrets: [SECRET],
      requestUrl: URL,
      method: "POST",
      now: new Date(NOW_MS + 31_000), // 31s later — outside the 30s TTL
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("rejects the wrong secret", async () => {
    const sig = await signContentful({
      method: "POST",
      path: PATH,
      signedHeaders: requestHeaders,
      body: BODY,
    });
    const result = await getAdapterForScheme("contentful")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [...requestHeaders, ["x-contentful-signature", sig]],
      secrets: ["b".repeat(64)],
      requestUrl: URL,
      method: "POST",
      now: new Date(NOW_MS + 2000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("rejects when a signed header named in the list is absent (MALFORMED)", async () => {
    const result = await getAdapterForScheme("contentful")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-contentful-timestamp", String(NOW_MS)],
        ["x-contentful-signed-headers", signedHeaderNames], // names x-contentful-space-id but it's absent
        ["x-contentful-signature", "00".repeat(32)],
      ],
      secrets: [SECRET],
      requestUrl: URL,
      method: "POST",
      now: new Date(NOW_MS + 2000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
