// Minimal ANSI styling for the read commands. Color is applied ONLY to small status tokens (an
// endpoint's active/paused state, an event's verified/unverified state, the audit result) and is
// gated on the caller's resolved `colorEnabled` (TTY- + NO_COLOR-aware; see context.ts), so piped or
// NO_COLOR output is plain. stripAnsi lets the table renderer measure VISIBLE width so a colored cell
// still aligns with its uncolored neighbors.

const CODES = {
  green: 32,
  yellow: 33,
  red: 31,
  dim: 2,
} as const;
export type Color = keyof typeof CODES;

// ESC (0x1b) built from its char code so the source stays plain ASCII — no raw control byte and no
// control-char escape in a regex literal (mirrors the by-code approach in contract/src/auth.ts).
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/** Wrap `text` in an SGR color when `enabled`; otherwise return it untouched. */
export function colorize(text: string, color: Color, enabled: boolean): string {
  if (!enabled) return text;
  return `${ESC}[${CODES[color]}m${text}${RESET}`;
}

// Matches the CSI SGR escapes colorize emits, so visible width can be measured for alignment. Built
// via RegExp from the by-code ESC, so there is no control char in a regex literal to lint or mis-copy.
// eslint-disable-next-line security/detect-non-literal-regexp -- the pattern is a fixed constant (the ESC byte + a static SGR shape), never user input
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Strip ANSI SGR escapes — used to measure the printed (visible) width of a styled cell. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
