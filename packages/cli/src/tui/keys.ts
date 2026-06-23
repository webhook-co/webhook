// Pure raw-mode keypress decoding for the in-tail TUI. Raw stdin delivers bytes; this maps the chunks we
// care about to a small command vocabulary (everything else → "none"). Kept pure + total so the whole key
// surface is unit-tested; the raw-mode enabling + the read loop are the coverage-excluded io seam.

/** A decoded TUI command. `none` = a key we don't bind (ignored). */
export type TuiKey = "up" | "down" | "detail" | "replay" | "open" | "quit" | "none";

const ESC = "\x1b"; // \e — the prefix of the arrow-key CSI/SS3 sequences and a bare Escape
const CTRL_C = "\x03"; // ETX

/**
 * Decode one raw-stdin chunk into a TUI command. Arrows arrive as the ANSI sequences `ESC [ A`/`ESC [ B`
 * (and the `O`-prefixed application-cursor variants); `j`/`k` mirror down/up (vim); `d`/`r`/`o` are the
 * actions; `q`, Ctrl-C, and a bare ESC quit. Unknown input is `none`.
 */
export function decodeKey(chunk: string): TuiKey {
  switch (chunk) {
    case `${ESC}[A`:
    case `${ESC}OA`:
    case "k":
      return "up";
    case `${ESC}[B`:
    case `${ESC}OB`:
    case "j":
      return "down";
    case "d":
      return "detail";
    case "r":
      return "replay";
    case "o":
      return "open";
    case "q":
    case CTRL_C:
    case ESC: // a bare Escape (not the start of a longer sequence)
      return "quit";
    default:
      return "none";
  }
}
