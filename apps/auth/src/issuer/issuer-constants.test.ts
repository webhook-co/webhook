import { describe, expect, it } from "vitest";

import { resolveOrigin } from "./issuer-constants";

// resolveOrigin builds the consent screen's "Requesting from" trust signal. ip + country come from the edge
// HEADERS (cf-connecting-ip / cf-ipcountry); city/region/regionCode come from request.cf (the Cloudflare
// request metadata), read structurally + null-safely so dev/test (no cf) and a non-Workers Request don't
// throw.

function reqWith(headers: Record<string, string>, cf?: Record<string, unknown>): Request {
  const request = new Request("https://auth.webhook.co/authorize", { headers });
  if (cf) Object.assign(request, { cf });
  return request;
}

describe("resolveOrigin", () => {
  it("reads the ip + country from the edge headers", () => {
    const o = resolveOrigin(reqWith({ "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "PT" }));
    expect(o.ip).toBe("203.0.113.7");
    expect(o.location).toBe("PT");
  });

  it("surfaces city/region/regionCode from request.cf when present", () => {
    const o = resolveOrigin(
      reqWith(
        { "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "PT" },
        { city: "Lisbon", region: "Lisboa", regionCode: "11" },
      ),
    );
    expect(o.city).toBe("Lisbon");
    expect(o.region).toBe("Lisboa");
    expect(o.regionCode).toBe("11");
  });

  it("is null-safe when request.cf (and its fields) are absent — dev/test / non-Workers Request", () => {
    const o = resolveOrigin(reqWith({ "cf-connecting-ip": "203.0.113.7" }));
    expect(o.city).toBeNull();
    expect(o.region).toBeNull();
    expect(o.regionCode).toBeNull();
    expect(o.location).toBeNull(); // no cf-ipcountry
  });

  it("preserves the existing unknown-ip + XX/T1 (Tor/unknown) country handling", () => {
    const o = resolveOrigin(reqWith({ "cf-ipcountry": "T1" }));
    expect(o.ip).toBe("unknown");
    expect(o.location).toBeNull();
  });

  it("ignores non-string cf fields (defensive — only strings are surfaced)", () => {
    const o = resolveOrigin(
      reqWith({ "cf-connecting-ip": "1.1.1.1" }, { city: 123, region: null, regionCode: "" }),
    );
    expect(o.city).toBeNull();
    expect(o.region).toBeNull();
    expect(o.regionCode).toBeNull(); // empty string → null too
  });
});
