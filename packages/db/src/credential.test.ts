import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCredentialHasher,
  credentialCacheKey,
  credentialHashEquals,
  CREDENTIAL_PEPPER_MIN_BYTES,
  CREDENTIAL_SECRET_BYTES,
  mintCredential,
} from "./credential";

// Fixed, distinct test peppers (>=32 bytes). Real peppers come from a secret, never a literal.
const PEPPER_A = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xa1);
const PEPPER_B = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xb2);
const hasherA = createCredentialHasher({ current: PEPPER_A });
const hasherB = createCredentialHasher({ current: PEPPER_B });

describe("createCredentialHasher", () => {
  it("rejects a pepper shorter than 256 bits (fails loud, no weak default)", () => {
    expect(() => createCredentialHasher({ current: Buffer.alloc(16, 1) })).toThrow(
      /pepper must be >= 32 bytes/,
    );
  });

  it("rejects a too-short PREVIOUS pepper too", () => {
    expect(() =>
      createCredentialHasher({ current: PEPPER_A, previous: [Buffer.alloc(8, 1)] }),
    ).toThrow(/pepper must be >= 32 bytes/);
  });
});

describe("mintCredential", () => {
  it("mints a prefixed, high-entropy plaintext and the matching HMAC-SHA256 hash", () => {
    const { plaintext, keyHash, start } = mintCredential("whk", hasherA);
    expect(plaintext.startsWith("whk_")).toBe(true);
    // 32 random bytes base64url-encode to >=43 chars; plus "whk_" -> clearly long.
    expect(plaintext.length).toBeGreaterThan(40);
    // keyHash is HMAC-SHA256(pepper, plaintext), NOT a bare sha256.
    const expected = createHmac("sha256", PEPPER_A).update(plaintext, "utf8").digest();
    expect(Buffer.compare(keyHash, expected)).toBe(0);
    expect(keyHash.length).toBe(32); // HMAC-SHA256 digest width
    // `start` is a short, non-secret display handle — never the full secret.
    expect(start.length).toBeLessThan(plaintext.length);
    expect(plaintext.startsWith(start)).toBe(true);
  });

  it("uses >=256 bits of entropy (the ADR-0003 floor)", () => {
    expect(CREDENTIAL_SECRET_BYTES * 8).toBeGreaterThanOrEqual(256);
  });

  it("never repeats a plaintext across mints (CSPRNG)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mintCredential("whk", hasherA).plaintext);
    expect(seen.size).toBe(200);
  });
});

describe("pepper keying — the DB-only-breach defense", () => {
  it("the same plaintext hashes DIFFERENTLY under different peppers", () => {
    // The core property: a stolen key_hash cannot be matched/confirmed without the pepper,
    // because the pepper (not in the DB) is required to reproduce the hash.
    const plaintext = "whk_same-secret";
    expect(Buffer.compare(hasherA.hash(plaintext), hasherB.hash(plaintext))).not.toBe(0);
  });

  it("hashes deterministically under a fixed pepper", () => {
    expect(Buffer.compare(hasherA.hash("whk_abc"), hasherA.hash("whk_abc"))).toBe(0);
  });
});

describe("candidates — pepper rotation", () => {
  it("with no previous pepper, there is exactly one candidate (the current hash)", () => {
    const cands = hasherA.candidates("whk_x");
    expect(cands.length).toBe(1);
    expect(Buffer.compare(cands[0], hasherA.hash("whk_x"))).toBe(0);
  });

  it("during rotation, candidates cover current THEN previous peppers", () => {
    const rotating = createCredentialHasher({ current: PEPPER_B, previous: [PEPPER_A] });
    const cands = rotating.candidates("whk_y");
    expect(cands.length).toBe(2);
    // current pepper first (B), then the previous one (A) so old keys still verify.
    expect(Buffer.compare(cands[0], hasherB.hash("whk_y"))).toBe(0);
    expect(Buffer.compare(cands[1], hasherA.hash("whk_y"))).toBe(0);
    // mint() always uses the CURRENT pepper.
    expect(Buffer.compare(rotating.hash("whk_y"), hasherB.hash("whk_y"))).toBe(0);
  });
});

describe("credentialHashEquals", () => {
  it("constant-time compare returns true for equal hashes, false otherwise", () => {
    const a = hasherA.hash("whk_one");
    const b = hasherA.hash("whk_one");
    const c = hasherA.hash("whk_two");
    expect(credentialHashEquals(a, b)).toBe(true);
    expect(credentialHashEquals(a, c)).toBe(false);
  });

  it("returns false (does not throw) on a length mismatch", () => {
    expect(credentialHashEquals(Buffer.from("short"), hasherA.hash("whk_x"))).toBe(false);
  });
});

describe("credentialCacheKey", () => {
  it("is the hex of the hash and never contains the plaintext", () => {
    const { plaintext, keyHash } = mintCredential("whk", hasherA);
    const key = credentialCacheKey(keyHash);
    expect(key).toBe(keyHash.toString("hex"));
    expect(key).not.toContain(plaintext.slice(4)); // the secret body
  });
});
