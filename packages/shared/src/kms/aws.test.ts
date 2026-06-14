import { afterEach, describe, expect, it, vi } from "vitest";

import { utf8Decoder, utf8Encoder } from "../bytes";
import { openSecret, sealSecret, type EncryptionContext } from "../envelope";
import { AwsKmsError, AwsKmsProvider, type AwsKmsConfig } from "./aws";

const ctx: EncryptionContext = { orgId: "org_1", endpointId: "ep_1", keyId: "key_1" };

const CONFIG: AwsKmsConfig = {
  keyArn: "arn:aws:kms:us-east-2:111122223333:key/11111111-2222-3333-4444-555555555555",
  region: "us-east-2",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

interface CapturedCall {
  url: string;
  target: string | null;
  authorization: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

/**
 * A fake AWS KMS over `fetch`: GenerateDataKey mints a random 32-byte DEK and "wraps" it by
 * embedding {dek, ctx} in the CiphertextBlob; Decrypt unwraps ONLY when the request's
 * EncryptionContext equals the one captured at generate time — mirroring KMS's real
 * confused-deputy enforcement, so the round-trip and the context-binding are both exercised.
 */
function installFakeKms(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const handler = async (input: Request): Promise<Response> => {
    const target = input.headers.get("x-amz-target");
    const raw = await input.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push({
      url: input.url,
      target,
      authorization: input.headers.get("authorization"),
      contentType: input.headers.get("content-type"),
      body,
    });

    if (target === "TrentService.GenerateDataKey") {
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const blob = utf8Encoder.encode(
        JSON.stringify({ dek: b64(dek), ctx: body.EncryptionContext }),
      );
      return jsonResponse({ KeyId: body.KeyId, Plaintext: b64(dek), CiphertextBlob: b64(blob) });
    }
    if (target === "TrentService.Decrypt") {
      const blob = JSON.parse(utf8Decoder.decode(unb64(body.CiphertextBlob as string))) as {
        dek: string;
        ctx: unknown;
      };
      if (JSON.stringify(blob.ctx) !== JSON.stringify(body.EncryptionContext)) {
        return errorResponse(400, "InvalidCiphertextException");
      }
      return jsonResponse({ KeyId: body.KeyId, Plaintext: blob.dek });
    }
    return errorResponse(400, "UnknownOperationException");
  };
  vi.stubGlobal("fetch", handler as unknown as typeof fetch);
  return calls;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/x-amz-json-1.1" },
  });
}

function errorResponse(status: number, awsType: string): Response {
  return new Response(JSON.stringify({ __type: awsType, message: "fake kms error" }), {
    status,
    headers: { "content-type": "application/x-amz-json-1.1" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AwsKmsProvider (mocked KMS)", () => {
  it("round-trips seal -> open through generateDek + unwrapDek", async () => {
    installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { dek, wrapped } = await kms.generateDek(ctx);

    const plaintext = utf8Encoder.encode("whsec_a_provider_secret");
    const sealed = await sealSecret(dek, plaintext, ctx);

    const unwrapped = await kms.unwrapDek(wrapped, ctx);
    const opened = await openSecret(unwrapped, sealed, ctx);
    expect(utf8Decoder.decode(opened)).toBe("whsec_a_provider_secret");
  });

  it("returns a non-extractable DEK handle from generateDek", async () => {
    installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { dek } = await kms.generateDek(ctx);
    expect(dek.extractable).toBe(false);
  });

  it("returns a non-extractable DEK handle from unwrapDek", async () => {
    installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { wrapped } = await kms.generateDek(ctx);
    const unwrapped = await kms.unwrapDek(wrapped, ctx);
    expect(unwrapped.extractable).toBe(false);
  });

  it("stamps wrapped.kekRef with the KMS key ARN", async () => {
    installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { wrapped } = await kms.generateDek(ctx);
    expect(wrapped.kekRef).toBe(CONFIG.keyArn);
  });

  it("signs the request and targets the right KMS endpoint + action + key spec", async () => {
    const calls = installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await kms.generateDek(ctx);

    const call = calls[0];
    expect(call.url).toBe("https://kms.us-east-2.amazonaws.com/");
    expect(call.target).toBe("TrentService.GenerateDataKey");
    expect(call.contentType).toBe("application/x-amz-json-1.1");
    // aws4fetch SigV4 signature must be present.
    expect(call.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(call.body.KeySpec).toBe("AES_256");
    expect(call.body.KeyId).toBe(CONFIG.keyArn);
    expect(call.body.EncryptionContext).toEqual({
      org_id: "org_1",
      endpoint_id: "ep_1",
      key_id: "key_1",
    });
  });

  it("passes the same EncryptionContext on Decrypt (KMS unwraps it)", async () => {
    const calls = installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { wrapped } = await kms.generateDek(ctx);
    await kms.unwrapDek(wrapped, ctx);
    const decrypt = calls.find((c) => c.target === "TrentService.Decrypt");
    expect(decrypt?.body.EncryptionContext).toEqual({
      org_id: "org_1",
      endpoint_id: "ep_1",
      key_id: "key_1",
    });
    expect(decrypt?.body.EncryptionAlgorithm).toBe("SYMMETRIC_DEFAULT");
    // KeyId pinned on Decrypt so a swapped ciphertext can't redirect the unwrap to another key.
    expect(decrypt?.body.KeyId).toBe(CONFIG.keyArn);
  });

  it("rejects unwrapping a DEK under a mismatched encryption context (KMS refuses)", async () => {
    installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { wrapped } = await kms.generateDek(ctx);
    await expect(kms.unwrapDek(wrapped, { ...ctx, orgId: "org_other" })).rejects.toBeInstanceOf(
      AwsKmsError,
    );
  });

  it("rejects unwrapping a DEK whose kekRef doesn't match this provider (no KMS call)", async () => {
    const calls = installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const { wrapped } = await kms.generateDek(ctx);
    await expect(
      kms.unwrapDek({ ...wrapped, kekRef: "arn:aws:kms:us-east-2:111122223333:key/other" }, ctx),
    ).rejects.toThrow(/kek ref mismatch/i);
    // The mismatch is caught before any Decrypt round-trip.
    expect(calls.some((c) => c.target === "TrentService.Decrypt")).toBe(false);
  });

  it("produces distinct DEKs and distinct wraps per call", async () => {
    installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    const a = await kms.generateDek(ctx);
    const b = await kms.generateDek(ctx);
    expect(Buffer.from(a.wrapped.wrappedDek).equals(Buffer.from(b.wrapped.wrappedDek))).toBe(false);
  });

  it("exposes its kekRef", () => {
    const kms = AwsKmsProvider.fromConfig({ ...CONFIG, keyArn: "arn:aws:kms:us-east-2:1:key/k" });
    expect(kms.kekRef).toBe("arn:aws:kms:us-east-2:1:key/k");
  });

  it("throws AwsKmsError carrying the AWS __type on a KMS error response", async () => {
    vi.stubGlobal("fetch", (async () =>
      errorResponse(403, "AccessDeniedException")) as unknown as typeof fetch);
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek(ctx)).rejects.toMatchObject({
      name: "AwsKmsError",
      awsType: "AccessDeniedException",
    });
  });

  it("throws AwsKmsError when the response is missing Plaintext", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        KeyId: CONFIG.keyArn,
        CiphertextBlob: b64(new Uint8Array(8)),
      })) as unknown as typeof fetch);
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek(ctx)).rejects.toThrow(/missing Plaintext/);
  });

  it("throws AwsKmsError when KMS returns a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    );
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek(ctx)).rejects.toThrow(/non-JSON body/);
  });

  it("throws AwsKmsError when the network fetch itself fails", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek(ctx)).rejects.toBeInstanceOf(AwsKmsError);
  });

  it("classifies an undecodable base64 blob as AwsKmsError (not a raw TypeError)", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        KeyId: CONFIG.keyArn,
        // atob rejects this; the provider must surface AwsKmsError, preserving the 5xx-not-401 rule.
        Plaintext: "!!!! not base64 !!!!",
        CiphertextBlob: b64(new Uint8Array(8)),
      })) as unknown as typeof fetch);
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek(ctx)).rejects.toThrow(/was not valid base64/);
  });

  it("throws AwsKmsError with undefined awsType on a non-2xx, non-JSON body", async () => {
    // e.g. a proxy/load-balancer 503 with an HTML body, not KMS's JSON error shape.
    // retries:0 so the 5xx surfaces immediately (default would back off and retry it).
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response("<html>503 Service Unavailable</html>", {
          status: 503,
        })) as unknown as typeof fetch,
    );
    const kms = AwsKmsProvider.fromConfig({ ...CONFIG, retries: 0 });
    await expect(kms.generateDek(ctx)).rejects.toMatchObject({
      name: "AwsKmsError",
      awsType: undefined,
      message: expect.stringContaining("returned 503"),
    });
  });

  it("retries a transient 5xx and then succeeds (bounded resilience)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", (async (input: Request) => {
      n++;
      if (n === 1) return new Response("<html>503</html>", { status: 503 });
      const body = JSON.parse(await input.text()) as Record<string, unknown>;
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const blob = utf8Encoder.encode(
        JSON.stringify({ dek: b64(dek), ctx: body.EncryptionContext }),
      );
      return new Response(
        JSON.stringify({ KeyId: body.KeyId, Plaintext: b64(dek), CiphertextBlob: b64(blob) }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);
    const kms = AwsKmsProvider.fromConfig({ ...CONFIG, retries: 2 });
    const { dek } = await kms.generateDek(ctx);
    expect(dek.extractable).toBe(false);
    expect(n).toBe(2); // one 503 + one success
  });

  it("rejects an empty EncryptionContext field before any KMS call (binding hardening)", async () => {
    const calls = installFakeKms();
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek({ ...ctx, orgId: "" })).rejects.toThrow(/must be non-empty/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a too-short DEK from KMS (length guard via importDek)", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        KeyId: CONFIG.keyArn,
        Plaintext: b64(new Uint8Array(16)),
        CiphertextBlob: b64(new Uint8Array(8)),
      })) as unknown as typeof fetch);
    const kms = AwsKmsProvider.fromConfig(CONFIG);
    await expect(kms.generateDek(ctx)).rejects.toThrow(/DEK must be/);
  });

  it("fromConfig requires keyArn and region", () => {
    expect(() => AwsKmsProvider.fromConfig({ ...CONFIG, keyArn: "" })).toThrow(/keyArn/);
    expect(() => AwsKmsProvider.fromConfig({ ...CONFIG, region: "" })).toThrow(/region/);
  });
});

// Opt-in live round-trip against the real KEK. Skips cleanly when creds aren't present (mirrors
// the nightly-RLS live-Neon pattern), so CI without AWS secrets is unaffected. Run with:
//   WS_B2_LIVE_KMS=1 WS_B2_KMS_KEY_ARN=<arn> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… pnpm -F @webhook-co/shared test
const live =
  process.env.WS_B2_LIVE_KMS === "1" &&
  !!process.env.WS_B2_KMS_KEY_ARN &&
  !!process.env.AWS_ACCESS_KEY_ID &&
  !!process.env.AWS_SECRET_ACCESS_KEY;

describe.runIf(live)("AwsKmsProvider (live AWS KMS)", () => {
  it("round-trips seal -> open against the real KEK", async () => {
    const kms = AwsKmsProvider.fromConfig({
      keyArn: process.env.WS_B2_KMS_KEY_ARN as string,
      region: process.env.WS_B2_KMS_REGION ?? "us-east-2",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    });
    const { dek, wrapped } = await kms.generateDek(ctx);
    const sealed = await sealSecret(dek, utf8Encoder.encode("whsec_live_roundtrip"), ctx);
    const unwrapped = await kms.unwrapDek(wrapped, ctx);
    expect(utf8Decoder.decode(await openSecret(unwrapped, sealed, ctx))).toBe(
      "whsec_live_roundtrip",
    );

    // A mismatched context must be refused by real KMS too.
    await expect(kms.unwrapDek(wrapped, { ...ctx, orgId: "org_wrong" })).rejects.toBeInstanceOf(
      AwsKmsError,
    );
  });
});
