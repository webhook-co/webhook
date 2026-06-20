import { describe, expect, it } from "vitest";

import { isAllowedRedirectUri, validateClientRegistration } from "./dcr";

// A3 — open-DCR hardening: a registered redirect_uri must be https or an http loopback literal
// (127.0.0.1/::1), never plain-http-to-another-host (the phishing vector) or localhost (hijackable).

describe("isAllowedRedirectUri", () => {
  it("allows http loopback literals (incl. shorthands that canonicalize to a true loopback)", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:53123/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:53123/cb")).toBe(true);
    // IPv4 shorthands canonicalize to 127.0.0.1 (a genuine loopback) → allowed.
    expect(isAllowedRedirectUri("http://2130706433/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.1/cb")).toBe(true);
  });

  it("rejects https (v1 is loopback-only; A8 relaxes once the consent screen gates remote clients)", () => {
    expect(isAllowedRedirectUri("https://app.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://127.0.0.1/cb")).toBe(false);
  });

  it("rejects userinfo-confusion, non-loopback http, localhost, and non-URLs", () => {
    // The classic bypass: the host is evil.com, the "127.0.0.1" is userinfo — url.hostname catches it.
    expect(isAllowedRedirectUri("http://127.0.0.1@evil.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://evil.com#@127.0.0.1/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:53123/cb")).toBe(false); // ADR-0026: hijackable, not a true loopback
    expect(isAllowedRedirectUri("http://127.0.0.1.evil.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("ftp://127.0.0.1/cb")).toBe(false);
    expect(isAllowedRedirectUri("not-a-url")).toBe(false);
  });
});

describe("validateClientRegistration", () => {
  it("allows a registration whose every redirect_uri is an http loopback", () => {
    expect(
      validateClientRegistration({
        redirect_uris: ["http://127.0.0.1:9000/cb", "http://[::1]:9001/cb"],
      }),
    ).toBeUndefined();
  });

  it("rejects when any redirect_uri is disallowed (a remote host, or https in v1)", () => {
    expect(
      validateClientRegistration({
        redirect_uris: ["http://127.0.0.1:9000/cb", "http://evil.example.com/cb"],
      }),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
    // https is rejected in v1 (loopback-only) — even a single https entry fails the registration.
    expect(validateClientRegistration({ redirect_uris: ["https://x.test/cb"] })).toMatchObject({
      code: "invalid_redirect_uri",
    });
  });

  it("rejects a missing / empty / non-array redirect_uris", () => {
    expect(validateClientRegistration({})).toMatchObject({ code: "invalid_redirect_uri" });
    expect(validateClientRegistration({ redirect_uris: [] })).toMatchObject({
      code: "invalid_redirect_uri",
    });
    expect(validateClientRegistration({ redirect_uris: "http://127.0.0.1/cb" })).toMatchObject({
      code: "invalid_redirect_uri",
    });
  });

  it("rejects a non-string entry in redirect_uris", () => {
    expect(validateClientRegistration({ redirect_uris: [123] })).toMatchObject({
      code: "invalid_redirect_uri",
    });
  });
});
