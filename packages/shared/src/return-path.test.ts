import { describe, expect, it } from "vitest";

import { sanitizeReturnPath } from "./return-path";

const APP = "https://app.webhook.co";

// A returnTo/next value is an untrusted, cross-origin-arriving string. The guard is an ORIGIN check, not a
// byte-pattern: browsers strip \t\n\r while parsing a Location, so a value must be judged as the browser will
// act on it. Ported from apps/auth's resolvePostLoginTarget, generalized over the origin.
describe("sanitizeReturnPath", () => {
  it("accepts a genuine same-origin path, with or without a query", () => {
    expect(sanitizeReturnPath("/invite/accept?org=abc", APP)).toBe("/invite/accept?org=abc");
    expect(sanitizeReturnPath("/org/acme/dashboard", APP)).toBe("/org/acme/dashboard");
  });

  it("rejects null / undefined / empty / a bare slash (no destination)", () => {
    for (const v of [null, undefined, "", "/"]) expect(sanitizeReturnPath(v, APP)).toBeNull();
  });

  it("rejects protocol-relative and backslash / encoded origin escapes", () => {
    for (const v of ["//evil.com", "/\\evil.com", "/%2Fevil.com", "/%2fevil.com", "/%5Cevil.com"]) {
      expect(sanitizeReturnPath(v, APP)).toBeNull();
    }
  });

  it("rejects absolute URLs and scheme smuggling", () => {
    for (const v of ["https://evil.com", "https:/evil.com", "http://app.webhook.co.evil.com"]) {
      expect(sanitizeReturnPath(v, APP)).toBeNull();
    }
  });

  it("strips the control chars a browser strips from a Location, then judges the result", () => {
    // "/\t/evil.com" → the browser parses "//evil.com" → different origin → reject.
    for (const v of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "\t//evil.com"]) {
      expect(sanitizeReturnPath(v, APP)).toBeNull();
    }
  });
});
