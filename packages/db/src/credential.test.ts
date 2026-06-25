import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCredentialHasher,
  createCredentialHasherFromBase64,
  credentialCacheKey,
  credentialHashEquals,
  CREDENTIAL_PEPPER_MIN_BYTES,
  CREDENTIAL_SECRET_BYTES,
  mintChecksummedCredential,
  mintCredential,
} from "./credential";
import { verifyKeyChecksum } from "./key-checksum";

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

describe("createCredentialHasherFromBase64", () => {
  it("builds a hasher equivalent to one over the decoded pepper (Workers-secret entry point)", () => {
    const b64 = PEPPER_A.toString("base64");
    const fromB64 = createCredentialHasherFromBase64(b64);
    // Same pepper bytes -> identical HMAC, so a token minted under either verifies under both.
    expect(fromB64.hash("whk_same").equals(hasherA.hash("whk_same"))).toBe(true);
  });

  it("accepts previous peppers (rotation) so a key minted under an old pepper still resolves", () => {
    const current = PEPPER_B.toString("base64");
    const previous = [PEPPER_A.toString("base64")];
    const rotated = createCredentialHasherFromBase64(current, previous);
    const candidates = rotated.candidates("whk_rot").map((b) => b.toString("hex"));
    expect(candidates).toContain(hasherB.hash("whk_rot").toString("hex")); // current
    expect(candidates).toContain(hasherA.hash("whk_rot").toString("hex")); // previous (old pepper)
  });

  it("rejects a too-short decoded pepper (length is validated, not silently accepted)", () => {
    const shortB64 = Buffer.alloc(16, 0x01).toString("base64");
    expect(() => createCredentialHasherFromBase64(shortB64)).toThrow(/pepper/i);
  });

  it("rejects non-strict base64 instead of letting Node's lenient decoder silently drop chars", () => {
    // base64url chars (-/_) and bad-length strings would decode to a WRONG-but-accepted buffer
    // under Node's lenient decoder, quietly changing every hash. They must throw, not be accepted.
    const valid = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x42).toString("base64");
    expect(() => createCredentialHasherFromBase64(`${valid.slice(0, -1)}-`)).toThrow(/base64/i); // base64url '-'
    expect(() => createCredentialHasherFromBase64("AAA")).toThrow(/base64/i); // length not % 4
    // A previous-pepper entry is validated the same way (the rotation list isn't a bypass).
    expect(() => createCredentialHasherFromBase64(valid, ["not*valid*base64"])).toThrow(/base64/i);
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

describe("mintChecksummedCredential", () => {
  it("mints whk_ + 43 base62 body + 6 base62 checksum (53 chars) that self-verifies", () => {
    const { plaintext } = mintChecksummedCredential("whk", hasherA);
    expect(plaintext).toMatch(/^whk_[0-9A-Za-z]{49}$/);
    expect(plaintext).toHaveLength(53);
    // The checksum is part of the plaintext and passes its own verifier.
    expect(verifyKeyChecksum("whk", plaintext)).toBe(true);
  });

  it("hashes the FULL plaintext (checksum included) — at-rest semantics unchanged", () => {
    const { plaintext, keyHash } = mintChecksummedCredential("whk", hasherA);
    const expected = createHmac("sha256", PEPPER_A).update(plaintext, "utf8").digest();
    expect(Buffer.compare(keyHash, expected)).toBe(0);
    expect(keyHash.length).toBe(32);
  });

  it("keeps `start` an 11-char non-secret prefix that never reaches the checksum", () => {
    const { plaintext, start } = mintChecksummedCredential("whk", hasherA);
    expect(start).toHaveLength(11);
    expect(plaintext.startsWith(start)).toBe(true);
    // index 11 is well inside the 43-char random body, far from the trailing 6-char checksum.
    expect(start).toBe(plaintext.slice(0, 11));
  });

  it("uses fresh entropy each mint (no collisions)", () => {
    const a = mintChecksummedCredential("whk", hasherA).plaintext;
    const b = mintChecksummedCredential("whk", hasherA).plaintext;
    expect(a).not.toBe(b);
  });

  it("does NOT change the generic mintCredential (ingest tokens stay base64url)", () => {
    // Regression guard: whep_ ingest tokens are minted via mintCredential and must be untouched
    // (base64url body, no checksum) — so they are NOT rejected by verifyKeyChecksum's whk_ shape.
    const { plaintext } = mintCredential("whep", hasherA);
    expect(plaintext.startsWith("whep_")).toBe(true);
    expect(verifyKeyChecksum("whep", plaintext)).toBe(false); // no checksum -> not the new shape
  });
});
