import { describe, expect, it } from "vitest";

import { redactSecret, SERVICE_NAME } from "./index.js";

describe("SERVICE_NAME", () => {
  it("identifies the service", () => {
    expect(SERVICE_NAME).toBe("webhook");
  });
});

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
