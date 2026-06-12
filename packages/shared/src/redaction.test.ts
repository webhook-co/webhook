import { describe, expect, it } from "vitest";

import { redactHeadersForLog, redactSecret } from "./redaction";

describe("redactSecret", () => {
  it("returns an empty string for empty input", () => {
    expect(redactSecret("")).toBe("");
  });

  it("keeps a short visible prefix and masks the rest", () => {
    expect(redactSecret("whsec_abcdef")).toBe("whse********");
  });

  it("respects a custom visible prefix length", () => {
    expect(redactSecret("abcdef", 2)).toBe("ab****");
  });

  it("never reveals more than the secret length", () => {
    expect(redactSecret("ab", 8)).toBe("ab");
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
