import { describe, expect, it } from "vitest";

import type { KeyFetchSpec } from "../../adapter";
import { bytesToHex, sha256, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Plaid — ES256 JWT in `Plaid-Verification`, body bound by `request_body_sha256`, key fetched by kid from an
// AUTHENTICATED endpoint (creds in the registered JSON secret). Self-minted: a fresh EC P-256 keypair → the
// `{ key: <JWK> }` response (mocked into fetchKey) + an ES256 JWT signed by it.

const KID = "plaid-kid-1";
const SECRET = JSON.stringify({
  environment: "sandbox",
  client_id: "test-client",
  secret: "test-secret",
});
const BODY = '{"webhook_type":"TRANSACTIONS","webhook_code":"DEFAULT_UPDATE"}';
const IAT = 1790000000;
const NOW = new Date((IAT + 100) * 1000); // within the 5-min window

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function setup(): Promise<{
  keyResponse: Uint8Array;
  mint: (claims: Record<string, unknown>, alg?: string) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const keyResponse = utf8Encoder.encode(
    JSON.stringify({ key: { ...jwk, kid: KID, alg: "ES256", use: "sig" } }),
  );
  const mint = async (claims: Record<string, unknown>, alg = "ES256"): Promise<string> => {
    const header = b64url(utf8Encoder.encode(JSON.stringify({ alg, typ: "JWT", kid: KID })));
    const payload = b64url(utf8Encoder.encode(JSON.stringify(claims)));
    const signingInput = `${header}.${payload}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        kp.privateKey,
        utf8Encoder.encode(signingInput),
      ),
    );
    return `${signingInput}.${b64url(sig)}`;
  };
  return { keyResponse, mint };
}

async function bodyHash(body: string): Promise<string> {
  return bytesToHex(await sha256(utf8Encoder.encode(body)));
}
function input(token: string, over: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode(BODY),
    headers: [["plaid-verification", token]] as [string, string][],
    secrets: [SECRET],
    now: NOW,
    ...over,
  };
}

describe("plaid bespoke (ES256 JWT, authenticated JWKS fetch, request_body_sha256)", () => {
  it("exposes plaid metadata", () => {
    const adapter = getAdapterForScheme("plaid")!;
    expect(adapter.scheme).toBe("plaid");
    expect(adapter.signatureHeader).toBe("plaid-verification");
  });

  it("verifies a JWT (authenticated key fetch + body-hash binding)", async () => {
    const { keyResponse, mint } = await setup();
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT });
    const fetchKey = async (spec: KeyFetchSpec) => {
      expect(spec.method).toBe("POST");
      expect(spec.url).toBe("https://sandbox.plaid.com/webhook_verification_key/get");
      expect(spec.allowedHosts).toEqual(["sandbox.plaid.com"]);
      expect(JSON.parse(spec.body!)).toEqual({
        client_id: "test-client",
        secret: "test-secret",
        key_id: KID,
      });
      return keyResponse;
    };
    expect(await getAdapterForScheme("plaid")!.verify(input(token, { fetchKey }))).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "plaid",
    });
  });

  it("rejects a mutated body (request_body_sha256 no longer matches) as PROXY_MUTATED_BYTES", async () => {
    const { keyResponse, mint } = await setup();
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT });
    const result = await getAdapterForScheme("plaid")!.verify(
      input(token, { rawBody: utf8Encoder.encode("{}"), fetchKey: async () => keyResponse }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("PROXY_MUTATED_BYTES");
  });

  it("rejects an expired token (iat past the window) as TIMESTAMP_TOO_OLD", async () => {
    const { keyResponse, mint } = await setup();
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT });
    const result = await getAdapterForScheme("plaid")!.verify(
      input(token, { fetchKey: async () => keyResponse, now: new Date((IAT + 100000) * 1000) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("rejects a signature under a different key as SIGNATURE_MISMATCH", async () => {
    const { mint } = await setup();
    const other = await setup(); // a different keypair's key response
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT });
    const result = await getAdapterForScheme("plaid")!.verify(
      input(token, { fetchKey: async () => other.keyResponse }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("fails soft to KEY_FETCH_FAILED when the key can't be fetched", async () => {
    const { mint } = await setup();
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT });
    const result = await getAdapterForScheme("plaid")!.verify(
      input(token, { fetchKey: async () => null }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });

  it("reports NO_MATCHING_KEY when the registered secret isn't valid Plaid creds", async () => {
    const { keyResponse, mint } = await setup();
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT });
    const result = await getAdapterForScheme("plaid")!.verify(
      input(token, { secrets: ["not-json"], fetchKey: async () => keyResponse }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("rejects a non-ES256 alg as MALFORMED_SIGNATURE", async () => {
    const { keyResponse, mint } = await setup();
    const token = await mint({ request_body_sha256: await bodyHash(BODY), iat: IAT }, "HS256");
    const result = await getAdapterForScheme("plaid")!.verify(
      input(token, { fetchKey: async () => keyResponse }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports MISSING_HEADER when Plaid-Verification is absent", async () => {
    const result = await getAdapterForScheme("plaid")!.verify(input("x", { headers: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
