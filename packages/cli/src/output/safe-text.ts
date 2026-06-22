// Make a server-controlled string safe to print into a human TEXT view. Endpoint names, dedup keys,
// content types, provider labels, and audit-break details are attacker-influenceable; rendered raw into
// the tables + key:value blocks + the live-tail line, a hostile value could embed an ANSI/terminal
// control sequence to forge output, hide text, clear the screen, or move the cursor — and a stray
// newline/tab would break table alignment. So every C0 control byte (NUL–US, which includes ESC, tab,
// CR, LF), DEL, and every C1 control byte (0x80–0x9F) is replaced with the Unicode replacement char,
// leaving all printable text (incl. astral code points) intact.
//
// Only the TEXT renderers call this. The JSON machine view is already safe — JSON.stringify escapes
// these bytes as \uXXXX — and the raw `events payload` byte stream is deliberately verbatim (not a
// rendered view). Implemented as a code-point scan (no regex) to avoid a control char in a regex literal
// (the `no-control-regex` rule), mirroring the by-code ESC handling in output/color.ts.
export function sanitizeControl(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "�" : char;
  }
  return out;
}
