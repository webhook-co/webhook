import { describe, expect, it } from "vitest";

import { redactHeadersForLog, redactSecret } from "./redaction";

describe("redactSecret", () => {
  it("returns an empty string for empty input", () => {
    expect(redactSecret("")).toBe("");
  });

  it("keeps a short visible prefix and a fixed-width mask (no length leak)", () => {
    expect(redactSecret("whsec_abcdef")).toBe("whse****");
    // a longer secret produces the same mask width — length is not disclosed
    expect(redactSecret("whsec_abcdefghijklmnop")).toBe("whse****");
  });

  it("respects a custom visible prefix length", () => {
    expect(redactSecret("abcdefghij", 2)).toBe("ab****");
  });

  it("fully masks a value too short to safely reveal a prefix", () => {
    expect(redactSecret("ab", 8)).toBe("****");
    expect(redactSecret("shortish")).toBe("****");
  });
});

describe("redactHeadersForLog", () => {
  it("passes allowlisted headers through and redacts the rest", () => {
    const view = redactHeadersForLog([
      ["Content-Type", "application/json"],
      ["Stripe-Signature", "t=1,v1=deadbeef"],
      ["Authorization", "Bearer secret"],
      ["webhook-id", "msg_123"],
    ]);
    expect(view).toEqual([
      ["Content-Type", "application/json"],
      ["Stripe-Signature", "[redacted]"],
      ["Authorization", "[redacted]"],
      ["webhook-id", "msg_123"],
    ]);
  });

  it("is case-insensitive on the allowlist", () => {
    expect(redactHeadersForLog([["CONTENT-TYPE", "text/plain"]])).toEqual([
      ["CONTENT-TYPE", "text/plain"],
    ]);
  });
});
