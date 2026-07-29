import { describe, expect, it } from "vitest";

import { TURNSTILE_SITEKEY, resolveTurnstileSitekey } from "./turnstile-sitekey";

// The login form disables submit until Turnstile hands back a token, so the widget is the difference
// between "I can sign in locally" and a permanently greyed-out button.
//
// It renders the REAL sitekey everywhere, including localhost. That is not a compromise: the widget's
// Cloudflare-side domain list contains `localhost` and `127.0.0.1` alongside `auth.webhook.co` (verified
// against the API), so the real widget solves locally and the real secret verifies it. Local therefore
// exercises the same captcha gate as production — which AGENTS.md requires.

describe("resolveTurnstileSitekey", () => {
  it("uses the real sitekey in production", () => {
    expect(resolveTurnstileSitekey("auth.webhook.co")).toBe(TURNSTILE_SITEKEY);
  });

  // The whole point of this change: no localhost special-case. An always-pass TEST sitekey would mean the
  // local captcha gate proved nothing, and the server-side secret would have to stay unwired to match.
  it("uses the SAME real sitekey on localhost — no test-key substitution", () => {
    expect(resolveTurnstileSitekey("localhost")).toBe(TURNSTILE_SITEKEY);
  });

  it("uses the real sitekey on the loopback IP", () => {
    expect(resolveTurnstileSitekey("127.0.0.1")).toBe(TURNSTILE_SITEKEY);
  });

  it("uses the real sitekey for any host — the function has no branches left to get wrong", () => {
    for (const host of ["", "preview.example.com", "localhost.attacker.example", "[::1]"]) {
      expect(resolveTurnstileSitekey(host)).toBe(TURNSTILE_SITEKEY);
    }
  });

  it("exposes a sitekey that looks like a real Cloudflare one, not a test key", () => {
    expect(TURNSTILE_SITEKEY).toMatch(/^0x4AAAAAA/);
    expect(TURNSTILE_SITEKEY).not.toMatch(/^[123]x0{10}/); // Cloudflare's documented test-key shapes
  });
});
