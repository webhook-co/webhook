import { describe, expect, it } from "vitest";

import {
  b64urlToBytes,
  bytesToB64url,
  bytesToHex,
  concatBytes,
  importHmacKey,
  timingSafeEqual,
} from "./bytes";

describe("byte helpers", () => {
  it("round-trips base64url for arbitrary bytes", () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
    expect([...b64urlToBytes(bytesToB64url(b))]).toEqual([...b]);
  });

  it("base64url output has no +, / or = padding", () => {
    const b = new Uint8Array([251, 255, 191]);
    const s = bytesToB64url(b);
    expect(s).not.toMatch(/[+/=]/);
  });

  it("hex-encodes bytes", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });

  it("timingSafeEqual compares content and length", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("concatBytes joins in order", () => {
    expect([...concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))]).toEqual([1, 2, 3]);
  });

  it("imports a non-extractable HMAC key", async () => {
    const key = await importHmacKey(new Uint8Array(32));
    expect(key.extractable).toBe(false);
    expect(key.type).toBe("secret");
  });
});
