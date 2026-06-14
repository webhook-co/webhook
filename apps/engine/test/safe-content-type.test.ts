import { describe, expect, it } from "vitest";

import { safeContentType } from "../src/index";

// The request Content-Type is fully attacker-controlled and is handed to R2 as object metadata.
// A value with control chars / CRLF / absurd length can make R2.put reject — and on the
// durable-before-ACK path a thrown put turns a well-formed event into a capture-blocking 500
// (the provider retries forever). safeContentType keeps only well-formed values; anything
// suspect is dropped (the canonical content-type is still persisted in the events row regardless).

describe("safeContentType", () => {
  it("passes through a normal MIME, including parameters", () => {
    expect(safeContentType("application/json")).toBe("application/json");
    expect(safeContentType("text/plain")).toBe("text/plain");
    expect(safeContentType("application/json; charset=utf-8")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("drops a null/empty content-type", () => {
    expect(safeContentType(null)).toBeUndefined();
    expect(safeContentType("")).toBeUndefined();
  });

  it("drops values with control characters or CRLF (header-injection / R2-reject shapes)", () => {
    expect(safeContentType("application/json\r\nX-Evil: 1")).toBeUndefined();
    expect(safeContentType("text/plain\t")).toBeUndefined(); // tab (0x09)
    expect(safeContentType("text/plain\x7f")).toBeUndefined(); // DEL (0x7f)
  });

  it("drops an absurdly long content-type", () => {
    expect(safeContentType("a/".concat("x".repeat(300)))).toBeUndefined();
  });
});
