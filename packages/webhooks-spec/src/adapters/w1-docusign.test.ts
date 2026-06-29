import { describe, expect, it } from "vitest";

import { hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// docusign (Connect): for EACH configured HMAC key, DocuSign computes Base64(HMAC-SHA256(key, body))
// over the raw request body and emits it as its own NUMBERED header — X-DocuSign-Signature-1,
// X-DocuSign-Signature-2, … (1-based, one per key). So multiple ACTIVE keys (rotation) means multiple
// headers, each a complete signature. Verification must collect EVERY numbered header and pass if any
// matches a registered secret — reading only `-1` would miss a body signed by the second key.

const SECRET = "a-test-signing-secret";
const OTHER_SECRET = "a-different-key";
const BODY = '{"event":"envelope-completed","id":"evt_docusign"}';
const NOW = new Date(1790000000 * 1000);

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function signB64(secret: string, body: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(body));
  return bytesToB64(mac);
}

describe("W1 docusign (numbered multi-header signatures)", () => {
  it("exposes x-docusign-signature-1 metadata", () => {
    const adapter = getAdapterForScheme("docusign")!;
    expect(adapter.scheme).toBe("docusign");
    expect(adapter.signatureHeader).toBe("x-docusign-signature-1");
  });

  it("verifies a body signed under the single configured key (X-DocuSign-Signature-1)", async () => {
    const sig = await signB64(SECRET, BODY);
    const result = await getAdapterForScheme("docusign")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["content-type", "application/json"],
        ["x-docusign-signature-1", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "docusign" });
  });

  it("verifies when the matching signature is in a LATER numbered header (key rotation)", async () => {
    // -1 is signed by a key we don't hold; -2 is signed by our registered secret. Reading only -1
    // would reject. The collector must consider every numbered header.
    const sig1 = await signB64(OTHER_SECRET, BODY);
    const sig2 = await signB64(SECRET, BODY);
    const result = await getAdapterForScheme("docusign")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-docusign-signature-1", sig1],
        ["x-docusign-signature-2", sig2],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "docusign" });
  });

  it("rejects a body signed by an unknown key (no numbered header matches)", async () => {
    const sig = await signB64(OTHER_SECRET, BODY);
    const result = await getAdapterForScheme("docusign")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-docusign-signature-1", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("reports MISSING_HEADER when no numbered signature header is present", async () => {
    const result = await getAdapterForScheme("docusign")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
