import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_SECRET_BYTES,
  credentialCacheKey,
  credentialHashEquals,
  hashCredential,
  mintCredential,
} from "./credential";

describe("mintCredential", () => {
  it("mints a prefixed, high-entropy plaintext and the matching sha256 hash", () => {
    const { plaintext, keyHash, start } = mintCredential("whk");
    expect(plaintext.startsWith("whk_")).toBe(true);
    // 32 random bytes base64url-encode to >=43 chars; plus "whk_" -> clearly long.
    expect(plaintext.length).toBeGreaterThan(40);
    expect(Buffer.compare(keyHash, createHash("sha256").update(plaintext).digest())).toBe(0);
    expect(keyHash.length).toBe(32); // sha256 digest width
    // `start` is a short, non-secret display handle — never the full secret.
    expect(start.length).toBeLessThan(plaintext.length);
    expect(plaintext.startsWith(start)).toBe(true);
  });

  it("uses >=256 bits of entropy (the ADR-0003 floor)", () => {
    expect(CREDENTIAL_SECRET_BYTES * 8).toBeGreaterThanOrEqual(256);
  });

  it("never repeats a plaintext across mints (CSPRNG)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mintCredential("whk").plaintext);
    expect(seen.size).toBe(200);
  });
});

describe("hashCredential / credentialHashEquals", () => {
  it("hashes deterministically", () => {
    expect(Buffer.compare(hashCredential("whk_abc"), hashCredential("whk_abc"))).toBe(0);
  });

  it("constant-time compare returns true for equal hashes, false otherwise", () => {
    const a = hashCredential("whk_one");
    const b = hashCredential("whk_one");
    const c = hashCredential("whk_two");
    expect(credentialHashEquals(a, b)).toBe(true);
    expect(credentialHashEquals(a, c)).toBe(false);
  });

  it("returns false (does not throw) on a length mismatch", () => {
    expect(credentialHashEquals(Buffer.from("short"), hashCredential("whk_x"))).toBe(false);
  });
});

describe("credentialCacheKey", () => {
  it("is the hex of the hash and never contains the plaintext", () => {
    const { plaintext, keyHash } = mintCredential("whk");
    const key = credentialCacheKey(keyHash);
    expect(key).toBe(keyHash.toString("hex"));
    expect(key).not.toContain(plaintext.slice(4)); // the secret body
  });
});
