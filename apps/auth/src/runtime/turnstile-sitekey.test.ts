import { describe, expect, it } from "vitest";

import {
  TURNSTILE_SITEKEY,
  TURNSTILE_TEST_SITEKEY,
  resolveTurnstileSitekey,
} from "./turnstile-sitekey";

// The login form disables submit until Turnstile hands back a token, so on a laptop the widget is the
// difference between "I can sign in locally" and a permanently greyed-out button. On localhost we render
// Cloudflare's documented always-pass TEST sitekey; everywhere else, the real one.

describe("resolveTurnstileSitekey", () => {
  it("uses the real sitekey in production", () => {
    expect(resolveTurnstileSitekey("auth.webhook.co")).toBe(TURNSTILE_SITEKEY);
  });

  it("uses the always-pass test sitekey on localhost", () => {
    expect(resolveTurnstileSitekey("localhost")).toBe(TURNSTILE_TEST_SITEKEY);
  });

  it("uses the test sitekey on the loopback IP too", () => {
    expect(resolveTurnstileSitekey("127.0.0.1")).toBe(TURNSTILE_TEST_SITEKEY);
  });

  it("uses the test sitekey on the IPv6 loopback", () => {
    expect(resolveTurnstileSitekey("[::1]")).toBe(TURNSTILE_TEST_SITEKEY);
  });

  // Fail SAFE: anything that is not unambiguously loopback gets the real key. A preview host, an unexpected
  // hostname, an empty string — none of them should quietly render a widget that passes everyone.
  it("falls back to the real sitekey for an unknown host", () => {
    expect(resolveTurnstileSitekey("preview.example.com")).toBe(TURNSTILE_SITEKEY);
  });

  it("falls back to the real sitekey for an empty hostname", () => {
    expect(resolveTurnstileSitekey("")).toBe(TURNSTILE_SITEKEY);
  });

  // A host merely CONTAINING "localhost" is not localhost — `localhost.attacker.example` must not get the
  // always-pass key. This is why the match is exact rather than a substring test.
  it("does not treat a lookalike host as loopback", () => {
    expect(resolveTurnstileSitekey("localhost.attacker.example")).toBe(TURNSTILE_SITEKEY);
    expect(resolveTurnstileSitekey("notlocalhost")).toBe(TURNSTILE_SITEKEY);
  });

  it("is case-insensitive about the hostname, as DNS is", () => {
    expect(resolveTurnstileSitekey("LOCALHOST")).toBe(TURNSTILE_TEST_SITEKEY);
  });

  it("keeps the two keys distinct — otherwise every assertion above is vacuous", () => {
    expect(TURNSTILE_SITEKEY).not.toBe(TURNSTILE_TEST_SITEKEY);
  });
});
