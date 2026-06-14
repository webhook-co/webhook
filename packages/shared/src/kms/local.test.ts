import { describe, expect, it } from "vitest";

import { utf8Decoder, utf8Encoder } from "../bytes";
import { openSecret, sealSecret, type EncryptionContext } from "../envelope";
import { LocalKmsProvider } from "./local";

const ctx: EncryptionContext = { orgId: "org_1", endpointId: "ep_1", keyId: "key_1" };

describe("LocalKmsProvider (dev/CI KEK)", () => {
  it("round-trips seal -> open through generateDek + unwrapDek", async () => {
    const kms = await LocalKmsProvider.generate();
    const { dek, wrapped } = await kms.generateDek(ctx);

    const plaintext = utf8Encoder.encode("whsec_a_provider_secret");
    const sealed = await sealSecret(dek, plaintext, ctx);

    const unwrapped = await kms.unwrapDek(wrapped, ctx);
    const opened = await openSecret(unwrapped, sealed, ctx);
    expect(utf8Decoder.decode(opened)).toBe("whsec_a_provider_secret");
  });

  it("returns a non-extractable DEK handle from generateDek", async () => {
    const kms = await LocalKmsProvider.generate();
    const { dek } = await kms.generateDek(ctx);
    expect(dek.extractable).toBe(false);
  });

  it("returns a non-extractable DEK handle from unwrapDek", async () => {
    const kms = await LocalKmsProvider.generate();
    const { wrapped } = await kms.generateDek(ctx);
    const unwrapped = await kms.unwrapDek(wrapped, ctx);
    expect(unwrapped.extractable).toBe(false);
  });

  it("stamps wrapped.kekRef with the local key id", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-test");
    const { wrapped } = await kms.generateDek(ctx);
    expect(wrapped.kekRef).toBe("local-kek-test");
  });

  it("rejects unwrapping a DEK under a mismatched encryption context (AAD binding)", async () => {
    const kms = await LocalKmsProvider.generate();
    const { wrapped } = await kms.generateDek(ctx);
    await expect(kms.unwrapDek(wrapped, { ...ctx, orgId: "org_other" })).rejects.toBeTruthy();
  });

  it("rejects unwrapping a DEK whose kekRef doesn't match this provider", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-a");
    const { wrapped } = await kms.generateDek(ctx);
    await expect(kms.unwrapDek({ ...wrapped, kekRef: "local-kek-b" }, ctx)).rejects.toThrow(/kek/i);
  });

  it("rejects a tampered wrapped DEK (GCM tag over the wrap)", async () => {
    const kms = await LocalKmsProvider.generate();
    const { wrapped } = await kms.generateDek(ctx);
    const tampered = Uint8Array.from(wrapped.wrappedDek);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(kms.unwrapDek({ ...wrapped, wrappedDek: tampered }, ctx)).rejects.toBeTruthy();
  });

  it("produces distinct DEKs and distinct wraps per call", async () => {
    const kms = await LocalKmsProvider.generate();
    const a = await kms.generateDek(ctx);
    const b = await kms.generateDek(ctx);
    // Different random DEK + different wrap nonce => different ciphertext.
    expect(Buffer.from(a.wrapped.wrappedDek).equals(Buffer.from(b.wrapped.wrappedDek))).toBe(false);
  });

  it("exposes its kekRef", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-named");
    expect(kms.kekRef).toBe("local-kek-named");
  });

  it("rejects a wrong-length raw KEK in fromRawKek", async () => {
    await expect(LocalKmsProvider.fromRawKek(new Uint8Array(16))).rejects.toThrow(/KEK must be/);
  });

  it("rejects a wrapped DEK too short to hold a nonce + ciphertext", async () => {
    const kms = await LocalKmsProvider.generate();
    const { wrapped } = await kms.generateDek(ctx);
    await expect(kms.unwrapDek({ ...wrapped, wrappedDek: new Uint8Array(4) }, ctx)).rejects.toThrow(
      /too short/,
    );
  });

  it("can be constructed from exported raw KEK bytes (round-trip across instances)", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-shared");
    const raw = await kms.exportRawKek();
    const { dek, wrapped } = await kms.generateDek(ctx);
    const sealed = await sealSecret(dek, utf8Encoder.encode("s"), ctx);

    const kms2 = await LocalKmsProvider.fromRawKek(raw, "local-kek-shared");
    const unwrapped = await kms2.unwrapDek(wrapped, ctx);
    expect(utf8Decoder.decode(await openSecret(unwrapped, sealed, ctx))).toBe("s");
  });
});
