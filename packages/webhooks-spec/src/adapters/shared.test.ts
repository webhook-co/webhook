import { describe, expect, it } from "vitest";

import { hexToBytes, bytesToHex, timingSafeEqual, concatBytes } from "../bytes";
import { findHeader, toCandidates, verifyHmacHex } from "./shared";

describe("byte helpers", () => {
  it("round-trips hex", () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xff, 0xa5]);
    expect(bytesToHex(bytes)).toBe("000fffa5");
    expect(hexToBytes("000fffa5")).toEqual(bytes);
  });

  it("rejects odd-length and non-hex strings", () => {
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
  });

  it("timingSafeEqual is false on length mismatch and content mismatch", () => {
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });

  it("concatBytes joins in order", () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});

describe("findHeader", () => {
  it("is case-insensitive and returns the first match", () => {
    const headers: ReadonlyArray<readonly [string, string]> = [
      ["X-Foo", "1"],
      ["x-foo", "2"],
    ];
    expect(findHeader(headers, "x-foo")).toBe("1");
    expect(findHeader(headers, "missing")).toBeUndefined();
  });
});

describe("verifyHmacHex", () => {
  const candidates = toCandidates(["s1", "s2"]);

  it("returns MALFORMED_SIGNATURE for a non-hex expected digest", async () => {
    const result = await verifyHmacHex({
      scheme: "github",
      rawBody: new Uint8Array([1, 2, 3]),
      expectedHexes: ["nothex"],
      candidates,
      buildMessage: (b) => b,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("returns NO_MATCHING_KEY when there are no candidates", async () => {
    const result = await verifyHmacHex({
      scheme: "github",
      rawBody: new Uint8Array([1]),
      expectedHexes: ["ab"],
      candidates: [],
      buildMessage: (b) => b,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("NO_MATCHING_KEY");
      if (result.reason.code === "NO_MATCHING_KEY") expect(result.reason.keysTried).toBe(0);
    }
  });

  it("returns SIGNATURE_MISMATCH for non-SHA256-shaped hex that matches nothing", async () => {
    // 2 hex chars => valid hex, wrong length for a SHA-256 digest => no WRONG_SECRET claim.
    const result = await verifyHmacHex({
      scheme: "github",
      rawBody: new Uint8Array([1, 2, 3]),
      expectedHexes: ["ab"],
      candidates,
      buildMessage: (b) => b,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("does not crash probing a non-UTF8 / non-JSON body (falls through to a diagnosis)", async () => {
    // Invalid UTF-8 bytes: the reencode-JSON probe must swallow the decode error.
    const result = await verifyHmacHex({
      scheme: "github",
      rawBody: new Uint8Array([0xff, 0xfe, 0xfd]),
      expectedHexes: ["a".repeat(64)],
      candidates,
      buildMessage: (b) => b,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });
});
