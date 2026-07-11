import { describe, expect, it } from "vitest";

import { clientIdentityDomain, redirectHostLabel, sanitizeClientName } from "./client-display";

// The consent screen renders a client's self-asserted name as the headline. For a DCR or CIMD client that
// name is ENTIRELY attacker-controlled (validateClientRegistration checks only redirect_uris; a CIMD doc is
// self-hosted). React escapes HTML so there's no XSS, but an attacker can still smuggle bidi-override /
// control characters to visually reorder the headline, or pad it to overflow the layout. These helpers make
// the name safe to display and derive the UN-spoofable signals (identity domain, redirect host) we show
// alongside it.
//
// Invisible/bidi inputs are constructed with String.fromCodePoint (never literal chars) so this source file
// carries none of the characters under test and can't itself trip a trojan-source scanner.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const RLO = 0x202e; // RIGHT-TO-LEFT OVERRIDE
const LRO = 0x202d; // LEFT-TO-RIGHT OVERRIDE
const LRI = 0x2066; // LEFT-TO-RIGHT ISOLATE
const PDI = 0x2069; // POP DIRECTIONAL ISOLATE

describe("sanitizeClientName", () => {
  it("keeps an ordinary name intact", () => {
    expect(sanitizeClientName("Claude Code")).toBe("Claude Code");
    expect(sanitizeClientName("Zed")).toBe("Zed");
  });

  it("strips Unicode bidi-override + directional-isolate controls (headline-reorder defense)", () => {
    expect(sanitizeClientName(`Claude${cp(RLO)}Code`)).toBe("ClaudeCode");
    expect(sanitizeClientName(`${cp(LRO, LRI)}evil${cp(PDI)}`)).toBe("evil");
  });

  it("strips the wider bidi + invisible classes (ALM, word-joiner, tag chars, variation selectors)", () => {
    const inject = (code: number) => `Ac${cp(code)}me`;
    expect(sanitizeClientName(inject(0x061c))).toBe("Acme"); // ARABIC LETTER MARK
    expect(sanitizeClientName(inject(0x2060))).toBe("Acme"); // WORD JOINER
    expect(sanitizeClientName(inject(0xe0041))).toBe("Acme"); // tag char
    expect(sanitizeClientName(inject(0xfe0f))).toBe("Acme"); // variation selector
  });

  it("strips C0/C1 control chars and newlines", () => {
    expect(sanitizeClientName("Acme\n\r\tTool")).toBe("Acme Tool");
    expect(sanitizeClientName(`a${cp(0x00)}b`)).toBe("ab");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(sanitizeClientName("  Acme    Tool  ")).toBe("Acme Tool");
  });

  it("clamps to a bounded length (no layout-overflow headline)", () => {
    const out = sanitizeClientName("A".repeat(500));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("clamps on code points so an astral char at the boundary isn't split into a lone surrogate", () => {
    const out = sanitizeClientName("😀".repeat(200));
    expect([...out].every((c) => c.codePointAt(0)! <= 0xd7ff || c.codePointAt(0)! >= 0xe000)).toBe(
      true,
    );
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to a neutral label when the name is empty or all-stripped", () => {
    expect(sanitizeClientName("")).toBe("Unnamed app");
    expect(sanitizeClientName(cp(RLO, LRO))).toBe("Unnamed app");
    expect(sanitizeClientName("   ")).toBe("Unnamed app");
  });
});

describe("clientIdentityDomain", () => {
  it("returns the host of a CIMD https client_id (the proven-controlled domain)", () => {
    expect(clientIdentityDomain("https://claude.ai/oauth/claude-code-client-metadata")).toBe(
      "claude.ai",
    );
    expect(clientIdentityDomain("https://zed.dev/oauth/client-metadata.json")).toBe("zed.dev");
  });

  it("returns null for an opaque DCR client id (no proven domain to display)", () => {
    expect(clientIdentityDomain("cli_wbhk")).toBeNull();
    expect(clientIdentityDomain("not a url")).toBeNull();
    expect(clientIdentityDomain("http://example.com/x")).toBeNull(); // not https → not a CIMD identity
  });
});

describe("redirectHostLabel", () => {
  it("shows the host for a remote https redirect", () => {
    expect(redirectHostLabel("https://vscode.dev/redirect")).toEqual({
      host: "vscode.dev",
      isLoopback: false,
    });
  });

  it("flags a loopback redirect (the consent screen warns on localhost-only)", () => {
    expect(redirectHostLabel("http://127.0.0.1:33418/")).toEqual({
      host: "127.0.0.1",
      isLoopback: true,
    });
    expect(redirectHostLabel("http://localhost/callback")).toEqual({
      host: "localhost",
      isLoopback: true,
    });
  });

  it("returns null host for an unparseable redirect", () => {
    expect(redirectHostLabel("not a url")).toEqual({ host: null, isLoopback: false });
  });
});
