import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Decoder, utf8Encoder } from "./bytes";
import {
  DEK_BYTES,
  GCM_NONCE_BYTES,
  encryptionContextAad,
  generateDekKey,
  importDek,
  openSecret,
  sealSecret,
  type EncryptionContext,
} from "./envelope";

const ctx: EncryptionContext = { orgId: "org_kat", endpointId: "ep_kat", keyId: "key_kat" };
const dekBytes = new Uint8Array(Array.from({ length: DEK_BYTES }, (_, i) => i));
const nonce = new Uint8Array(Array.from({ length: GCM_NONCE_BYTES }, (_, i) => i));

describe("envelope AES-256-GCM (M6)", () => {
  it("matches the known-answer vector (locks the format + AAD)", async () => {
    // Vector independently computed with WebCrypto AES-256-GCM over the same key,
    // nonce, AAD (env1|7:org_kat6:ep_kat7:key_kat), and plaintext.
    const KAT = "306aa57ea6bab67efe35c8f8d48a0a08f789f1559c0e3a75c440e50c42019b1d84151df3d3e2a4";
    const dek = await importDek(dekBytes);
    const sealed = await sealSecret(dek, utf8Encoder.encode("whsec_test_secret_value"), ctx, nonce);
    expect(bytesToHex(sealed.ciphertext)).toBe(KAT);
  });

  it("builds the AAD as length-prefixed context", () => {
    expect(utf8Decoder.decode(encryptionContextAad(ctx))).toBe("env1|7:org_kat6:ep_kat7:key_kat");
  });

  it("round-trips seal -> open", async () => {
    const dek = await generateDekKey();
    const plaintext = utf8Encoder.encode("a provider secret");
    const sealed = await sealSecret(dek, plaintext, ctx);
    expect(sealed.nonce.length).toBe(GCM_NONCE_BYTES);
    const opened = await openSecret(dek, sealed, ctx);
    expect(utf8Decoder.decode(opened)).toBe("a provider secret");
  });

  it("fails to open under a different context (AAD binding / confused-deputy)", async () => {
    const dek = await generateDekKey();
    const sealed = await sealSecret(dek, utf8Encoder.encode("x"), ctx);
    await expect(openSecret(dek, sealed, { ...ctx, keyId: "other" })).rejects.toBeTruthy();
  });

  it("rejects a tampered ciphertext (GCM tag) and a tampered nonce", async () => {
    const dek = await generateDekKey();
    const sealed = await sealSecret(dek, utf8Encoder.encode("secret"), ctx);
    const flippedCt = Uint8Array.from(sealed.ciphertext);
    flippedCt[0] ^= 0x01;
    await expect(openSecret(dek, { ...sealed, ciphertext: flippedCt }, ctx)).rejects.toBeTruthy();
    const flippedNonce = Uint8Array.from(sealed.nonce);
    flippedNonce[0] ^= 0x01;
    await expect(openSecret(dek, { ...sealed, nonce: flippedNonce }, ctx)).rejects.toBeTruthy();
  });

  it("rejects a wrong-length DEK and a wrong-length nonce", async () => {
    expect(() => importDek(new Uint8Array(16))).toThrow(/DEK must be/);
    const dek = await generateDekKey();
    await expect(sealSecret(dek, utf8Encoder.encode("x"), ctx, new Uint8Array(8))).rejects.toThrow(
      /nonce must be/,
    );
  });

  it("generates non-extractable DEK handles (M7)", async () => {
    const dek = await generateDekKey();
    expect(dek.extractable).toBe(false);
  });
});
