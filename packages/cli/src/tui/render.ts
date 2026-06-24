// Pure renderer for the in-tail TUI: a TuiState → the full text frame. The runner (run.ts) wraps the
// frame in the alt-screen + cursor-home control sequences and writes it; keeping this a pure function of
// state makes the whole layout snapshot-testable without a terminal.
//
// Width safety: every line is built as PLAIN text and hard-truncated to the terminal width FIRST, then
// color is painted onto whole-word verified/unverified tokens (color codes add no visible width). So no
// rendered line — colored or not — is ever wider than the terminal, and a hostile provider/id can't break
// the layout (server-controlled strings are control-sanitized).

import type { EventSummary } from "@webhook-co/shared";

import { colorize } from "../output/color.js";
import { sanitizeControl } from "../output/safe-text.js";
import { selectedEvent, visibleWindow, type TuiState } from "./state.js";

export interface RenderOpts {
  readonly color: boolean;
  /** Terminal width in columns; lines are truncated to fit. */
  readonly columns: number;
}

const HINTS = "↑/↓ move · r replay · o open · d detail · q quit";

/** Truncate to at most `columns` UTF-16 units (the line is still plain here — no color yet). If the cut
 *  would land between a surrogate pair (an astral char, e.g. an emoji in a provider name), drop the whole
 *  char rather than leave a lone surrogate that renders as a replacement glyph. */
export function fitWidth(line: string, columns: number): string {
  if (line.length <= columns) return line;
  let end = Math.max(0, columns);
  const last = line.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1; // high surrogate at the boundary → back off
  return line.slice(0, end);
}

/** Paint whole-word verified/unverified tokens green/yellow (no-op when color is off). Applied AFTER
 *  truncation, so the added SGR codes never change a line's visible width; a token cut by truncation no
 *  longer matches as a whole word and is simply left plain. */
function paintVerified(line: string, color: boolean): string {
  if (!color) return line;
  return line.replace(
    /(^|\s)(unverified|verified)(\s|$)/g,
    (_m, pre: string, tok: string, post: string) =>
      `${pre}${colorize(tok, tok === "verified" ? "green" : "yellow", color)}${post}`,
  );
}

function eventRow(e: EventSummary, isSelected: boolean): string {
  const marker = isSelected ? "›" : " ";
  const time = e.receivedAt.toISOString().slice(11, 19); // HH:MM:SS
  const provider = e.provider === null ? "—" : sanitizeControl(e.provider);
  const verified = e.verified ? "verified" : "unverified";
  return `${marker} ${time}  ${provider}  ${verified}  ${sanitizeControl(e.id)}`;
}

function detailLines(e: EventSummary): string[] {
  return [
    "── detail ──",
    `id:        ${sanitizeControl(e.id)}`,
    `received:  ${e.receivedAt.toISOString()}`,
    `provider:  ${e.provider === null ? "—" : sanitizeControl(e.provider)}`,
    `verified:  ${e.verified ? "verified" : "unverified"}`,
    `dedup:     ${sanitizeControl(e.dedupKey)} (${e.dedupStrategy})`,
    `endpoint:  ${sanitizeControl(e.endpointId)}`,
  ];
}

/** Render the whole TUI screen for `state` as a newline-joined frame, fitted to the terminal width. */
export function renderFrame(state: TuiState, opts: RenderOpts): string {
  const lines: string[] = [`wbhk listen · ${state.events.length} events`, ""];

  const window = visibleWindow(state);
  if (window.items.length === 0) {
    lines.push("waiting for events… (q to quit)");
  } else {
    window.items.forEach((e, i) => {
      lines.push(eventRow(e, window.offset + i === state.selected));
    });
  }

  if (state.detail) {
    const sel = selectedEvent(state);
    lines.push("");
    lines.push(...(sel ? detailLines(sel) : ["── detail ── (no event selected)"]));
  }

  lines.push("");
  lines.push(HINTS);
  if (state.status !== null) lines.push(sanitizeControl(state.status));

  return lines.map((line) => paintVerified(fitWidth(line, opts.columns), opts.color)).join("\n");
}
