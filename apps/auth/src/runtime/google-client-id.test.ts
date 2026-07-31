import { describe, expect, it } from "vitest";

import { isGoogleClientId } from "./google-client-id";

describe("isGoogleClientId", () => {
  it("accepts the current format", () => {
    expect(isGoogleClientId("1234567890-abc123def456.apps.googleusercontent.com")).toBe(true);
  });

  it("accepts the legacy suffix-less format", () => {
    expect(isGoogleClientId("1234567890.apps.googleusercontent.com")).toBe(true);
  });

  // The fault this exists for: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are adjacent keys in every
  // config file here, and a swap would otherwise put the SECRET in a public page's HTML.
  it("rejects a Google client secret", () => {
    expect(isGoogleClientId("GOCSPX-1a2b3c4d5e6f7g8h9i0j")).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["no project number", "-abc123.apps.googleusercontent.com"],
    ["wrong host", "1234567890-abc123.apps.example.com"],
    ["host as a prefix only", "1234567890-abc.apps.googleusercontent.com.evil.test"],
    ["host as a suffix of another label", "evil-1234567890-abc.apps.googleusercontent.com"],
    ["uppercase random part", "1234567890-ABC123.apps.googleusercontent.com"],
    ["untrimmed", " 1234567890-abc.apps.googleusercontent.com "],
    ["a URL", "https://1234567890-abc.apps.googleusercontent.com"],
    ["a JWT", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig"],
    ["newline-smuggled second value", "1234567890-abc.apps.googleusercontent.com\nevil"],
  ])("rejects %s", (_label, value) => {
    expect(isGoogleClientId(value)).toBe(false);
  });
});
