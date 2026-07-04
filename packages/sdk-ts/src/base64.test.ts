import { describe, expect, it } from "vitest";

import { base64ToBytes } from "./base64.js";
import { WebhookUnexpectedResponseError } from "./errors.js";

describe("base64ToBytes", () => {
  it("decodes standard base64 to the exact bytes", () => {
    expect([...base64ToBytes("aGVsbG8=")]).toEqual([104, 101, 108, 108, 111]); // "hello"
  });

  it("round-trips arbitrary binary bytes including 0x00 and 0xff", () => {
    expect([...base64ToBytes("AP8Q")]).toEqual([0, 255, 16]);
  });

  it("decodes the empty string to an empty array", () => {
    expect(base64ToBytes("").byteLength).toBe(0);
  });

  it("throws an unexpected-response error on malformed base64", () => {
    expect(() => base64ToBytes("not valid base64 !!!")).toThrow(WebhookUnexpectedResponseError);
  });
});
