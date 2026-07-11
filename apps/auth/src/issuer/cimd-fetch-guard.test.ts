import { describe, expect, it } from "vitest";

import { CIMD_AUTHORIZE_RULE, isCimdAuthorizeRequest } from "./cimd-fetch-guard";

const authorize = (clientId: string | null, method = "GET") => {
  const url = new URL("https://auth.webhook.co/authorize");
  if (clientId !== null) url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", "http://127.0.0.1/cb");
  return new Request(url, { method });
};

describe("isCimdAuthorizeRequest", () => {
  it("is true for a GET /authorize with a CIMD (https non-root-path) client_id", () => {
    expect(
      isCimdAuthorizeRequest(authorize("https://claude.ai/oauth/claude-code-client-metadata")),
    ).toBe(true);
    expect(isCimdAuthorizeRequest(authorize("https://acme.dev/client.json"))).toBe(true);
  });

  it("is false for an opaque DCR client_id (no fetch happens)", () => {
    expect(isCimdAuthorizeRequest(authorize("cli_wbhk"))).toBe(false);
    expect(isCimdAuthorizeRequest(authorize("https://example.com"))).toBe(false); // root path → not CIMD
  });

  it("is false for a missing client_id, a non-GET, or a different path", () => {
    expect(isCimdAuthorizeRequest(authorize(null))).toBe(false);
    expect(isCimdAuthorizeRequest(authorize("https://acme.dev/c.json", "POST"))).toBe(false);
    expect(
      isCimdAuthorizeRequest(
        new Request("https://auth.webhook.co/token?client_id=https://x.dev/c.json"),
      ),
    ).toBe(false);
  });

  it("uses a ceiling that sits UNDER the generic authorize limit (so it's the binding one for CIMD)", () => {
    expect(CIMD_AUTHORIZE_RULE.limit).toBeGreaterThan(0);
    expect(CIMD_AUTHORIZE_RULE.limit).toBeLessThan(120); // EDGE_RULES.authorize
    expect(CIMD_AUTHORIZE_RULE.windowSeconds).toBeGreaterThanOrEqual(60);
  });
});
