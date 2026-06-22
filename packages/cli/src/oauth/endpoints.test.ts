import { describe, expect, it } from "vitest";

import { InvalidAuthUrlError } from "../errors.js";
import { DEFAULT_AUTH_BASE_URL, oauthEndpoints, resolveAuthBaseUrl } from "./endpoints.js";

describe("resolveAuthBaseUrl", () => {
  it("defaults to the hosted issuer", () => {
    expect(resolveAuthBaseUrl({})).toBe(DEFAULT_AUTH_BASE_URL);
  });

  it("prefers the flag over the env", () => {
    expect(
      resolveAuthBaseUrl({ flag: "https://auth.dev.example", env: "https://env.example" }),
    ).toBe("https://auth.dev.example");
    expect(resolveAuthBaseUrl({ env: "https://env.example" })).toBe("https://env.example");
  });

  it("normalizes the origin (strips a trailing slash)", () => {
    expect(resolveAuthBaseUrl({ flag: "https://auth.dev.example/" })).toBe(
      "https://auth.dev.example",
    );
  });

  it("allows http only for loopback (dev)", () => {
    expect(resolveAuthBaseUrl({ flag: "http://127.0.0.1:3001" })).toBe("http://127.0.0.1:3001");
  });

  it("rejects a non-https, non-loopback issuer (credential-leak guard)", () => {
    expect(() => resolveAuthBaseUrl({ flag: "http://auth.evil.example" })).toThrow(
      InvalidAuthUrlError,
    );
  });

  it("rejects a URL with a query or fragment, and a malformed URL", () => {
    expect(() => resolveAuthBaseUrl({ flag: "https://auth.example?x=1" })).toThrow(
      InvalidAuthUrlError,
    );
    expect(() => resolveAuthBaseUrl({ flag: "not a url" })).toThrow(InvalidAuthUrlError);
  });

  it("rejects embedded userinfo (the `https://real@evil` confusion form)", () => {
    expect(() => resolveAuthBaseUrl({ flag: "https://auth.webhook.co@evil.example" })).toThrow(
      InvalidAuthUrlError,
    );
  });
});

describe("oauthEndpoints", () => {
  it("builds the issuer-root paths (frozen /token, not the provider's /oauth/token)", () => {
    const e = oauthEndpoints("https://auth.webhook.co");
    expect(e).toEqual({
      register: "https://auth.webhook.co/register",
      authorize: "https://auth.webhook.co/authorize",
      token: "https://auth.webhook.co/token",
      deviceAuthorization: "https://auth.webhook.co/device_authorization",
      revoke: "https://auth.webhook.co/revoke",
    });
  });
});
