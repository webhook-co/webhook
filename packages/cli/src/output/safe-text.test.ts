import { describe, expect, it } from "vitest";

import { sanitizeControl } from "./safe-text.js";

// Build control bytes by char code so the source stays plain ASCII (no raw control byte in a literal).
const ch = (code: number): string => String.fromCharCode(code);
const ESC = ch(27);
const REPL = "�"; // the Unicode replacement char the sanitizer substitutes in

describe("sanitizeControl", () => {
  it("leaves ordinary printable text (incl. unicode) untouched", () => {
    expect(sanitizeControl("orders-prod ✓ 日本語")).toBe("orders-prod ✓ 日本語");
  });

  it("replaces an injected ANSI escape so server data can't hijack the terminal", () => {
    const evil = `${ESC}[31mFAKE${ESC}[0m`;
    const out = sanitizeControl(evil);
    expect(out).not.toContain(ESC); // the control bytes are gone
    expect(out).toContain("FAKE"); // the visible text survives
  });

  it("replaces C0 control bytes (LF, tab, CR, NUL, BEL) with the replacement char", () => {
    const input = `a${ch(10)}b${ch(9)}c${ch(13)}d${ch(0)}e${ch(7)}f`;
    expect(sanitizeControl(input)).toBe(`a${REPL}b${REPL}c${REPL}d${REPL}e${REPL}f`);
  });

  it("replaces DEL and C1 control bytes", () => {
    const input = `x${ch(0x7f)}y${ch(0x9b)}z`;
    expect(sanitizeControl(input)).toBe(`x${REPL}y${REPL}z`);
  });

  it("preserves astral (multi-code-unit) characters", () => {
    expect(sanitizeControl("emoji 😀 ok")).toBe("emoji 😀 ok");
  });
});
