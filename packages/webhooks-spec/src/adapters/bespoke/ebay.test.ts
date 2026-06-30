import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { bytesToB64, utf8Encoder } from "../../bytes";
import type { KeyFetchSpec, VerifyInput } from "../../adapter";
import { makeEbayAdapter } from "./ebay";

// eBay Event Notification signature verification (SHA1withECDSA over the raw body; ADR-0080-class Tier-3
// remote-fetch + app-auth). No public gold vector exists, so we self-generate an EC P-256 keypair, sign the
// body with SHA-1 → DER (exactly eBay's `Signature.getInstance("SHA1withECDSA")` output), export the public
// key as X509 SPKI PEM (what getPublicKey returns), and drive a fake fetchKey that returns the eBay-shaped
// OAuth token + getPublicKey responses. This proves the full flow: header parse → token mint → key fetch →
// DER→raw → ECDSA-SHA1 verify. (It is NOT a live-eBay vector — that needs a real eBay app.)

const CREDS = JSON.stringify({
  env: "production",
  clientId: "ClientId-123",
  clientSecret: "s3cr3t-abc",
});
const KID = "key_2024_01";
const BODY = utf8Encoder.encode(
  '{"metadata":{"topic":"MARKETPLACE_ACCOUNT_DELETION"},"notification":{"data":{"username":"x"}}}',
);

/** Generate an EC P-256 keypair + a DER ECDSA-SHA1 signature over `body`, plus the SPKI PEM (eBay's format). */
function signLikeEbay(body: Uint8Array): {
  sigDerB64: string;
  spkiPem: string;
  privateKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sigDer = createSign("SHA1").update(body).sign(privateKey); // DER-encoded ECDSA sig
  const spkiPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { sigDerB64: sigDer.toString("base64"), spkiPem, privateKey };
}

/** Build the base64-JSON X-EBAY-SIGNATURE header value. */
function ebaySigHeader(kid: string, sigDerB64: string): string {
  return bytesToB64(
    utf8Encoder.encode(JSON.stringify({ alg: "ECDSA", kid, signature: sigDerB64, digest: "SHA1" })),
  );
}

/** A fake fetchKey serving eBay's OAuth token endpoint + getPublicKey, recording the specs it saw. */
function fakeFetchKey(opts: { keyPem: string; calls?: KeyFetchSpec[] }) {
  return async (spec: KeyFetchSpec): Promise<Uint8Array | null> => {
    opts.calls?.push(spec);
    if (spec.url.endsWith("/identity/v1/oauth2/token")) {
      return utf8Encoder.encode(
        JSON.stringify({ access_token: "APP-TOKEN-xyz", expires_in: 7200 }),
      );
    }
    if (spec.url.includes("/commerce/notification/v1/public_key/")) {
      return utf8Encoder.encode(
        JSON.stringify({ algorithm: "ECDSA", digest: "SHA1", key: opts.keyPem }),
      );
    }
    return null;
  };
}

function input(over: Partial<VerifyInput>): VerifyInput {
  return {
    rawBody: BODY,
    headers: [],
    secrets: [CREDS],
    now: new Date("2026-06-30T00:00:00Z"),
    ...over,
  };
}

describe("makeEbayAdapter — Event Notification SHA1withECDSA verification", () => {
  it("verifies a valid eBay-shaped signature (mint token → fetch key by kid → DER→raw → ECDSA-SHA1)", async () => {
    const { sigDerB64, spkiPem } = signLikeEbay(BODY);
    const calls: KeyFetchSpec[] = [];
    const result = await makeEbayAdapter().verify(
      input({
        headers: [["x-ebay-signature", ebaySigHeader(KID, sigDerB64)]],
        fetchKey: fakeFetchKey({ keyPem: spkiPem, calls }),
      }),
    );
    expect(result.ok).toBe(true);
    // step 1: the client-credentials token mint — POST with HTTP Basic, host-pinned
    expect(calls[0]!.url).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.allowedHosts).toContain("api.ebay.com");
    const basic = bytesToB64(utf8Encoder.encode("ClientId-123:s3cr3t-abc"));
    expect(calls[0]!.headers).toEqual(
      expect.arrayContaining([["authorization", `Basic ${basic}`]]),
    );
    // step 2: getPublicKey by kid, with the minted Bearer token
    expect(calls[1]!.url).toBe(`https://api.ebay.com/commerce/notification/v1/public_key/${KID}`);
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.headers).toEqual(
      expect.arrayContaining([["authorization", "Bearer APP-TOKEN-xyz"]]),
    );
  });

  it("rejects a signature over a TAMPERED body (SIGNATURE_MISMATCH)", async () => {
    const { sigDerB64, spkiPem } = signLikeEbay(BODY);
    const result = await makeEbayAdapter().verify(
      input({
        rawBody: utf8Encoder.encode('{"tampered":true}'),
        headers: [["x-ebay-signature", ebaySigHeader(KID, sigDerB64)]],
        fetchKey: fakeFetchKey({ keyPem: spkiPem }),
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts the X509 key whether eBay returns it as PEM or bare base64 SPKI", async () => {
    const { sigDerB64, spkiPem } = signLikeEbay(BODY);
    const bareB64 = spkiPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""); // strip PEM armor
    const result = await makeEbayAdapter().verify(
      input({
        headers: [["x-ebay-signature", ebaySigHeader(KID, sigDerB64)]],
        fetchKey: async (spec) =>
          spec.url.endsWith("/oauth2/token")
            ? utf8Encoder.encode(JSON.stringify({ access_token: "T" }))
            : utf8Encoder.encode(JSON.stringify({ key: bareB64 })),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("missing x-ebay-signature → MISSING_HEADER", async () => {
    const result = await makeEbayAdapter().verify(
      input({ fetchKey: fakeFetchKey({ keyPem: "x" }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });

  it("a non-base64 / non-JSON signature header → MALFORMED_SIGNATURE (never throws)", async () => {
    const result = await makeEbayAdapter().verify(
      input({
        headers: [["x-ebay-signature", "!!!not-base64!!!"]],
        fetchKey: fakeFetchKey({ keyPem: "x" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("no fetchKey wired → KEY_FETCH_FAILED (never crashes the capture path)", async () => {
    const { sigDerB64 } = signLikeEbay(BODY);
    const result = await makeEbayAdapter().verify(
      input({
        headers: [["x-ebay-signature", ebaySigHeader(KID, sigDerB64)]],
        fetchKey: undefined,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });

  it("skips a verify-token blob / non-creds secret (NO_MATCHING_KEY when no usable creds)", async () => {
    const { sigDerB64, spkiPem } = signLikeEbay(BODY);
    const result = await makeEbayAdapter().verify(
      input({
        secrets: [JSON.stringify({ kind: "verify_token", token: "abc" })], // not eBay app creds
        headers: [["x-ebay-signature", ebaySigHeader(KID, sigDerB64)]],
        fetchKey: fakeFetchKey({ keyPem: spkiPem }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });
});
