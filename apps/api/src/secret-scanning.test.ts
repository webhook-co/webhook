import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { classifyAndRevoke, verifyGithubSignature } from "./secret-scanning";

// A throwaway P-256 keypair to stand in for GitHub's secret_scanning key. GitHub signs the RAW
// body with ECDSA-P256-SHA256 and sends the signature as base64 ASN.1/DER — exactly what
// node:crypto `sign(..., { dsaEncoding: "der" })` produces, so this is a faithful fixture.
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

function signDerB64(body: Uint8Array): string {
  return sign("sha256", body, { key: privateKey, dsaEncoding: "der" }).toString("base64");
}

describe("verifyGithubSignature (DER ECDSA-P256 over the raw body, WebCrypto-verified)", () => {
  it("accepts a valid DER signature over the exact raw body", async () => {
    const body = new TextEncoder().encode('[{"token":"whk_abc","type":"webhook_co_api_key"}]');
    expect(await verifyGithubSignature(body, PEM, signDerB64(body))).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = new TextEncoder().encode('[{"token":"whk_abc"}]');
    const sig = signDerB64(body);
    const tampered = new TextEncoder().encode('[{"token":"whk_XYZ"}]');
    expect(await verifyGithubSignature(tampered, PEM, sig)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const body = new TextEncoder().encode("hello");
    const sig = sign("sha256", body, { key: other, dsaEncoding: "der" }).toString("base64");
    expect(await verifyGithubSignature(body, PEM, sig)).toBe(false);
  });

  it("rejects a garbage / non-DER signature without throwing", async () => {
    const body = new TextEncoder().encode("hello");
    expect(await verifyGithubSignature(body, PEM, "not-base64-der!!")).toBe(false);
    expect(await verifyGithubSignature(body, PEM, Buffer.from("garbage").toString("base64"))).toBe(
      false,
    );
  });

  it("handles many signatures (exercises the DER r/s leading-zero padding path)", async () => {
    // Different bodies yield r/s with varying leading-zero bytes; all must round-trip.
    for (let i = 0; i < 50; i++) {
      const body = new TextEncoder().encode(`payload-${i}`);
      expect(await verifyGithubSignature(body, PEM, signDerB64(body))).toBe(true);
    }
  });
});

describe("classifyAndRevoke (label semantics + revoke side-effect)", () => {
  const wellFormed = (t: string) => t.startsWith("whk_good");

  it("labels a checksum-failing token false_positive and never tries to revoke it", async () => {
    const revoke = vi.fn(async () => {});
    const out = await classifyAndRevoke([{ token: "whk_bad", type: "webhook_co_api_key" }], {
      isWellFormed: wellFormed,
      revoke,
    });
    expect(out).toEqual([
      { token_raw: "whk_bad", token_type: "webhook_co_api_key", label: "false_positive" },
    ]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("labels a checksum-passing token true_positive and revokes it (the side-effect, not the label criterion)", async () => {
    const revoke = vi.fn(async () => {});
    const out = await classifyAndRevoke([{ token: "whk_good_1", type: "webhook_co_api_key" }], {
      isWellFormed: wellFormed,
      revoke,
    });
    expect(out[0]?.label).toBe("true_positive");
    expect(revoke).toHaveBeenCalledWith("whk_good_1");
  });

  it("still labels a checksum-passing-but-unknown token true_positive (it IS our shape)", async () => {
    // revoke resolves even when the key isn't in our DB (found:false) — the label stays true_positive.
    const revoke = vi.fn(async () => {});
    const out = await classifyAndRevoke([{ token: "whk_good_unknown" }], {
      isWellFormed: wellFormed,
      revoke,
    });
    expect(out[0]?.label).toBe("true_positive");
  });

  it("defaults token_type when GitHub omits it, and processes each token in the array", async () => {
    const revoke = vi.fn(async () => {});
    const out = await classifyAndRevoke([{ token: "whk_good_a" }, { token: "whk_bad_b" }], {
      isWellFormed: wellFormed,
      revoke,
    });
    expect(out.map((o) => o.label)).toEqual(["true_positive", "false_positive"]);
    expect(out.every((o) => o.token_type === "webhook_co_api_key")).toBe(true);
  });
});
