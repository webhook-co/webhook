import { describe, expect, it } from "vitest";

import {
  CHECKSUM_LEN,
  crc32,
  keyChecksum,
  RANDOM_BODY_LEN,
  toBase62Fixed,
  verifyKeyChecksum,
} from "./key-checksum";

describe("crc32", () => {
  // Standard IEEE 802.3 (poly 0xEDB88320) known-answer vectors.
  it("matches standard known-answer vectors", () => {
    expect(crc32("") >>> 0).toBe(0x00000000);
    expect(crc32("a") >>> 0).toBe(0xe8b7be43);
    expect(crc32("123456789") >>> 0).toBe(0xcbf43926);
    expect(crc32("The quick brown fox jumps over the lazy dog") >>> 0).toBe(0x414fa339);
  });

  it("returns an unsigned 32-bit integer", () => {
    const v = crc32("The quick brown fox jumps over the lazy dog");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(v)).toBe(true);
  });
});

describe("toBase62Fixed", () => {
  it("left-pads to the requested fixed width", () => {
    expect(toBase62Fixed(0n, 6)).toBe("000000");
    expect(toBase62Fixed(1n, 6)).toBe("000001");
    expect(toBase62Fixed(61n, 1)).toBe("z");
    expect(toBase62Fixed(62n, 2)).toBe("10");
  });

  it("encodes the max CRC32 to the documented 6-char value", () => {
    expect(toBase62Fixed(BigInt(0xffffffff), CHECKSUM_LEN)).toBe("4gfFC3");
  });

  it("renders a full 256-bit value to exactly 43 chars (never 44)", () => {
    const max256 = (1n << 256n) - 1n;
    expect(toBase62Fixed(max256, RANDOM_BODY_LEN)).toHaveLength(RANDOM_BODY_LEN);
    expect(toBase62Fixed(0n, RANDOM_BODY_LEN)).toBe("0".repeat(RANDOM_BODY_LEN));
  });

  it("throws rather than truncate when the value exceeds the width capacity", () => {
    // 62^2 = 3844 needs 3 chars; asking for width 2 must throw, never silently truncate.
    expect(() => toBase62Fixed(BigInt(62 * 62), 2)).toThrow(/width/i);
    expect(() => toBase62Fixed(-1n, 6)).toThrow();
  });
});

describe("keyChecksum", () => {
  it("is the 6-char base62 of CRC32 over the body string", () => {
    const body = "abc";
    expect(keyChecksum(body)).toBe(toBase62Fixed(BigInt(crc32(body) >>> 0), CHECKSUM_LEN));
    expect(keyChecksum(body)).toHaveLength(CHECKSUM_LEN);
  });
});

describe("verifyKeyChecksum", () => {
  const prefix = "whk";
  const body = "A".repeat(RANDOM_BODY_LEN); // 43 base62 chars
  const good = `${prefix}_${body}${keyChecksum(body)}`;

  it("accepts a well-formed key whose checksum matches its body", () => {
    expect(verifyKeyChecksum(prefix, good)).toBe(true);
    expect(good).toMatch(/^whk_[0-9A-Za-z]{49}$/);
    expect(good).toHaveLength(53);
  });

  it("rejects a flipped body char (checksum no longer matches)", () => {
    const tampered = `${prefix}_${"B" + body.slice(1)}${keyChecksum(body)}`;
    expect(verifyKeyChecksum(prefix, tampered)).toBe(false);
  });

  it("rejects a flipped checksum char", () => {
    const cs = keyChecksum(body);
    const badCs = (cs[0] === "0" ? "1" : "0") + cs.slice(1);
    expect(verifyKeyChecksum(prefix, `${prefix}_${body}${badCs}`)).toBe(false);
  });

  it("rejects the wrong prefix", () => {
    expect(verifyKeyChecksum("whk", `whep_${body}${keyChecksum(body)}`)).toBe(false);
  });

  it("rejects a too-short / too-long body", () => {
    expect(verifyKeyChecksum(prefix, `${prefix}_${body}`)).toBe(false); // missing checksum
    expect(verifyKeyChecksum(prefix, `${prefix}_${body}${keyChecksum(body)}X`)).toBe(false);
  });

  it("rejects base64url chars (-, _) — i.e. the OLD base64url format is rejected", () => {
    // An old-format key is whk_ + 43 base64url chars (no checksum), and may contain - or _.
    const oldFormat = "whk_js-OIpZ" + "a".repeat(36); // resembles the founder's old key shape
    expect(verifyKeyChecksum(prefix, oldFormat)).toBe(false);
    expect(verifyKeyChecksum(prefix, `${prefix}_${"a".repeat(42)}_${"b".repeat(6)}`)).toBe(false);
  });
});
