import { describe, expect, it } from "vitest";

import {
  ALLOWED_HTTPS_REDIRECT_HOSTS,
  isHttpLoopbackRedirect,
  isRegisterableRedirectUri,
  validateClientRegistration,
} from "./dcr";

// The MCP authorization spec (every revision) requires the AS to accept redirect URIs that are either
// an http loopback (RFC 8252: 127.0.0.0/8, ::1, or localhost, ANY port/path) or remote https. To keep
// open DCR from becoming a consent-phishing vector, remote https is restricted to an allowlist of the
// known MCP-vendor callback hosts (an attacker can't self-register https://evil.com). Custom schemes
// (Cursor desktop's cursor://) and plain-http-to-a-remote-host are rejected; those callers use a
// first-party `whk_` bearer token instead.

describe("isRegisterableRedirectUri — http loopback (any port/path)", () => {
  it("accepts the loopback IP literals with any port and path", () => {
    expect(isRegisterableRedirectUri("http://127.0.0.1:53123/cb")).toBe(true);
    expect(isRegisterableRedirectUri("http://[::1]:53123/cb")).toBe(true);
    expect(isRegisterableRedirectUri("http://127.0.0.1/cb")).toBe(true); // no port
  });

  it("accepts `localhost` — Claude Code, VS Code, Continue use it (RFC 8252 / provider parity)", () => {
    expect(isRegisterableRedirectUri("http://localhost:33333/callback")).toBe(true);
    expect(isRegisterableRedirectUri("http://localhost:3000/?state=abc")).toBe(true); // Continue
  });

  it("accepts the whole 127.0.0.0/8 block (provider isLoopbackUri parity)", () => {
    expect(isRegisterableRedirectUri("http://127.5.5.5:9000/cb")).toBe(true);
  });

  it("accepts real MCP-client loopback callback paths", () => {
    expect(isRegisterableRedirectUri("http://127.0.0.1:1455/callback/AbC123")).toBe(true); // Codex
    expect(isRegisterableRedirectUri("http://127.0.0.1:1456/mcp/oauth/callback")).toBe(true); // Cline
    expect(isRegisterableRedirectUri("http://localhost:3118/callback")).toBe(true); // Claude Code
  });

  it("accepts IPv4 shorthands that WHATWG-canonicalize to a loopback", () => {
    expect(isRegisterableRedirectUri("http://2130706433/cb")).toBe(true); // 127.0.0.1
    expect(isRegisterableRedirectUri("http://127.1/cb")).toBe(true); // 127.0.0.1
  });
});

describe("isRegisterableRedirectUri — allowlisted vendor https", () => {
  it("accepts each known MCP-vendor callback host", () => {
    expect(isRegisterableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isRegisterableRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isRegisterableRedirectUri("https://www.cursor.com/agents/mcp/oauth/callback")).toBe(
      true,
    );
    expect(isRegisterableRedirectUri("https://vscode.dev/redirect")).toBe(true);
    expect(isRegisterableRedirectUri("https://insiders.vscode.dev/redirect")).toBe(true);
  });

  it("treats userinfo as credentials for the real host, not the host itself", () => {
    // hostname is claude.ai (evil.com is userinfo) → the code still goes to claude.ai → allowed.
    expect(isRegisterableRedirectUri("https://evil.com@claude.ai/cb")).toBe(true);
  });

  it("exposes the allowlist for docs/other callers", () => {
    expect(ALLOWED_HTTPS_REDIRECT_HOSTS.has("claude.ai")).toBe(true);
    expect(ALLOWED_HTTPS_REDIRECT_HOSTS.has("evil.com")).toBe(false);
  });
});

describe("isRegisterableRedirectUri — rejections", () => {
  it("rejects non-allowlisted https (the phishing vector)", () => {
    expect(isRegisterableRedirectUri("https://app.example.com/cb")).toBe(false);
    expect(isRegisterableRedirectUri("https://evil.com/cb")).toBe(false);
  });

  it("rejects lookalikes of an allowlisted host", () => {
    expect(isRegisterableRedirectUri("https://claude.ai.evil.com/cb")).toBe(false);
    expect(isRegisterableRedirectUri("https://evil.com/claude.ai")).toBe(false); // host is evil.com
    // userinfo-confusion: the real host is evil.com.
    expect(isRegisterableRedirectUri("https://claude.ai@evil.com/cb")).toBe(false);
    // punycode homoglyph ("clаude.ai" with a Cyrillic а) is NOT claude.ai.
    expect(isRegisterableRedirectUri("https://xn--clude-4va.ai/cb")).toBe(false);
  });

  it("rejects our own origins (never a third-party client redirect)", () => {
    expect(isRegisterableRedirectUri("https://webhook.co/cb")).toBe(false);
    expect(isRegisterableRedirectUri("https://auth.webhook.co/cb")).toBe(false);
    expect(isRegisterableRedirectUri("https://mcp.webhook.co/cb")).toBe(false);
    expect(isRegisterableRedirectUri("https://wbhk.my/cb")).toBe(false);
  });

  it("rejects plain http to a non-loopback host, and loopback lookalikes", () => {
    expect(isRegisterableRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isRegisterableRedirectUri("http://127.0.0.1@evil.com/cb")).toBe(false); // host is evil.com
    expect(isRegisterableRedirectUri("http://localhost.evil.com/cb")).toBe(false);
    expect(isRegisterableRedirectUri("http://127.0.0.1.evil.com/cb")).toBe(false);
  });

  it("rejects custom schemes, dangerous schemes, and non-URLs", () => {
    expect(isRegisterableRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(false);
    expect(isRegisterableRedirectUri("vscode://callback")).toBe(false);
    expect(isRegisterableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isRegisterableRedirectUri("ftp://127.0.0.1/cb")).toBe(false);
    expect(isRegisterableRedirectUri("https://127.0.0.1/cb")).toBe(false); // https loopback: not allowlisted
    expect(isRegisterableRedirectUri("not-a-url")).toBe(false);
  });
});

describe("isHttpLoopbackRedirect — the narrow classifier for the server-302 bounce", () => {
  it("is true only for an http loopback (never https / remote)", () => {
    expect(isHttpLoopbackRedirect("http://127.0.0.1:53123/cb")).toBe(true);
    expect(isHttpLoopbackRedirect("http://[::1]/cb")).toBe(true);
    expect(isHttpLoopbackRedirect("http://localhost:8080/cb")).toBe(true);
  });

  it("is false for allowlisted https (those navigate directly, never through the bounce)", () => {
    expect(isHttpLoopbackRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(isHttpLoopbackRedirect("https://127.0.0.1/cb")).toBe(false); // https, not http
  });

  it("is false for remote http and non-URLs", () => {
    expect(isHttpLoopbackRedirect("http://evil.com/cb")).toBe(false);
    expect(isHttpLoopbackRedirect("not-a-url")).toBe(false);
  });
});

describe("validateClientRegistration", () => {
  it("allows a registration whose every redirect_uri is loopback or allowlisted https", () => {
    expect(
      validateClientRegistration({
        redirect_uris: ["http://127.0.0.1:9000/cb", "http://[::1]:9001/cb"],
      }),
    ).toBeUndefined();
    expect(
      validateClientRegistration({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    ).toBeUndefined();
    // A native client that registers both localhost + 127.0.0.1 (Claude Code's CIMD shape).
    expect(
      validateClientRegistration({
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      }),
    ).toBeUndefined();
  });

  it("rejects when any redirect_uri is disallowed (fail the whole registration)", () => {
    expect(
      validateClientRegistration({
        redirect_uris: ["http://127.0.0.1:9000/cb", "https://evil.example.com/cb"],
      }),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
    expect(validateClientRegistration({ redirect_uris: ["https://evil.com/cb"] })).toMatchObject({
      code: "invalid_redirect_uri",
    });
    expect(
      validateClientRegistration({
        redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      }),
    ).toMatchObject({ code: "invalid_redirect_uri" });
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
