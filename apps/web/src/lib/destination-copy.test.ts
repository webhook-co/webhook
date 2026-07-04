import { describe, expect, it } from "vitest";

import { destinationCopy, destinationDisplayStatus, destinationUrlError } from "./destination-copy";

describe("destinationDisplayStatus", () => {
  it("maps a live, enabled destination to active", () => {
    expect(destinationDisplayStatus({ status: "active", disabledAt: null })).toBe("active");
  });

  it("maps a live but auto-disabled destination to disabled", () => {
    expect(
      destinationDisplayStatus({ status: "active", disabledAt: new Date("2026-07-01T00:00:00Z") }),
    ).toBe("disabled");
  });

  it("maps a revoked destination to revoked regardless of disabledAt", () => {
    expect(destinationDisplayStatus({ status: "revoked", disabledAt: null })).toBe("revoked");
    expect(destinationDisplayStatus({ status: "revoked", disabledAt: new Date() })).toBe("revoked");
  });
});

describe("destinationCopy", () => {
  it("active earns an ok tone and no hint", () => {
    const c = destinationCopy("active");
    expect(c.tone).toBe("ok");
    expect(c.label).toBe("Active");
    expect(c.hint).toBeUndefined();
  });

  it("disabled earns a warn tone and an honest auto-disable hint", () => {
    const c = destinationCopy("disabled");
    expect(c.tone).toBe("warn");
    expect(c.label).toBe("Disabled");
    expect(c.hint).toMatch(/repeated/i);
    expect(c.hint).toMatch(/enable/i);
  });

  it("revoked earns a neutral tone", () => {
    const c = destinationCopy("revoked");
    expect(c.tone).toBe("neutral");
    expect(c.label).toBe("Revoked");
  });
});

describe("destinationUrlError — honest, structural SSRF copy", () => {
  it("explains non-https plainly", () => {
    expect(destinationUrlError("not_https")).toMatch(/https/i);
  });

  it("tells the user to drop credentials in the URL", () => {
    const msg = destinationUrlError("has_userinfo");
    expect(msg).toMatch(/username|password|credential/i);
  });

  it("names the port rule", () => {
    expect(destinationUrlError("disallowed_port")).toMatch(/port/i);
  });

  it("asks for a hostname, not an IP literal — without implying malice", () => {
    const msg = destinationUrlError("ip_literal_host");
    expect(msg).toMatch(/IP address/i);
    expect(msg).toMatch(/hostname|domain/i);
    // Honest: structural-only. Never accuse the URL of being an attack.
    expect(msg).not.toMatch(/malicious|attack|blocked/i);
  });

  it("asks for a full domain on a single-label host", () => {
    expect(destinationUrlError("single_label_host")).toMatch(/domain/i);
  });

  it("falls back to a generic valid-https message for parse-level reasons", () => {
    for (const r of [
      "unparseable",
      "empty_host",
      "bad_host_chars",
      "empty_label",
      "weird_new_reason",
    ]) {
      expect(destinationUrlError(r)).toMatch(/valid https/i);
    }
  });
});
