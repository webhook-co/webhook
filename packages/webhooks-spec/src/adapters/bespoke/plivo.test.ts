import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Plivo V3 bespoke adapter. No published crypto vector exists, but Plivo's docs give a verbatim worked
// base-string for the query+body case — this test signs THAT exact string and asserts the adapter
// (which rebuilds the base from the request) reproduces it, validating the stateful `?`/`.` glue,
// the key sort, and the URL-decode + render rules. Message = base + "." + nonce, HMAC-SHA256/std-base64.

const TOKEN = "plivo-auth-token-value";
const NONCE = "kjsdhfsd87sd7yisud2";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function plivoSign(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message))));
}

const NOW = new Date(1790000000 * 1000);

describe("plivo V3 bespoke (stateful base_url + nonce)", () => {
  it("exposes plivo metadata", () => {
    expect(getAdapterForScheme("plivo")!.scheme).toBe("plivo");
  });

  it("verifies the documented query+POST-body base string (case 1: ?Q.B)", async () => {
    // Exact base string from Plivo's docs (https://example.com/abcd?foo=bar . sorted body . nonce).
    const docBase =
      "https://example.com/abcd?foo=bar.CallUuid4vbcpem8-0u46-x1ha-9af1-438vc92bf374Digits1234From+15551111111To+15555555555";
    const sig = await plivoSign(TOKEN, `${docBase}.${NONCE}`);
    const result = await getAdapterForScheme("plivo")!.verify({
      rawBody: utf8Encoder.encode(
        "From=%2B15551111111&To=%2B15555555555&CallUuid=4vbcpem8-0u46-x1ha-9af1-438vc92bf374&Digits=1234",
      ),
      headers: [
        ["x-plivo-signature-v3", sig],
        ["x-plivo-signature-v3-nonce", NONCE],
      ],
      secrets: [TOKEN],
      requestUrl: "https://example.com/abcd?foo=bar",
      method: "POST",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "plivo" });
  });

  it("verifies a body-only POST (case 3: bare `?` forced, no `.`)", async () => {
    const base = "https://wbhk.my/whep_abc?CallUuidabc123From+15550000000";
    const sig = await plivoSign(TOKEN, `${base}.${NONCE}`);
    const result = await getAdapterForScheme("plivo")!.verify({
      rawBody: utf8Encoder.encode("From=%2B15550000000&CallUuid=abc123"),
      headers: [
        ["x-plivo-signature-v3", sig],
        ["x-plivo-signature-v3-nonce", NONCE],
      ],
      secrets: [TOKEN],
      requestUrl: "https://wbhk.my/whep_abc",
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("verifies a GET (case: URL + sorted query, no body)", async () => {
    const base = "https://wbhk.my/whep_abc?a=1&b=2";
    const sig = await plivoSign(TOKEN, `${base}.${NONCE}`);
    const result = await getAdapterForScheme("plivo")!.verify({
      rawBody: utf8Encoder.encode(""),
      headers: [
        ["x-plivo-signature-v3", sig],
        ["x-plivo-signature-v3-nonce", NONCE],
      ],
      secrets: [TOKEN],
      requestUrl: "https://wbhk.my/whep_abc?b=2&a=1", // unsorted on the wire → adapter sorts
      method: "GET",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("matches ANY of several comma-separated signatures (rotation)", async () => {
    const base = "https://wbhk.my/whep_abc";
    const sig = await plivoSign(TOKEN, `${base}.${NONCE}`);
    const result = await getAdapterForScheme("plivo")!.verify({
      rawBody: utf8Encoder.encode(""),
      headers: [
        ["x-plivo-signature-v3", `${b64(new Uint8Array(32))},${sig}`], // junk sig, then ours
        ["x-plivo-signature-v3-nonce", NONCE],
      ],
      secrets: [TOKEN],
      requestUrl: base,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("verifies via the main-account header (X-Plivo-Signature-Ma-V3, same base + nonce)", async () => {
    const base = "https://wbhk.my/whep_abc";
    const sig = await plivoSign(TOKEN, `${base}.${NONCE}`);
    const result = await getAdapterForScheme("plivo")!.verify({
      rawBody: utf8Encoder.encode(""),
      headers: [
        ["x-plivo-signature-ma-v3", sig], // only the main-account header present
        ["x-plivo-signature-v3-nonce", NONCE],
      ],
      secrets: [TOKEN],
      requestUrl: base,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects the wrong auth token", async () => {
    const base = "https://wbhk.my/whep_abc";
    const sig = await plivoSign("the-wrong-token", `${base}.${NONCE}`);
    const result = await getAdapterForScheme("plivo")!.verify({
      rawBody: utf8Encoder.encode(""),
      headers: [
        ["x-plivo-signature-v3", sig],
        ["x-plivo-signature-v3-nonce", NONCE],
      ],
      secrets: [TOKEN],
      requestUrl: base,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});
