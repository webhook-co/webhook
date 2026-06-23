// The in-tail TUI's state + its pure transitions. Every screen the TUI draws is a function of this
// value (see render.ts), and every keypress is one of these transitions (see run.ts) — keeping the
// whole interaction model pure + unit-testable, with only the raw-mode stdin + terminal writes behind
// the io seam.

import type { EventSummary } from "@webhook-co/shared";

export interface TuiState {
  /** Captured events, in arrival order (newest last). */
  readonly events: readonly EventSummary[];
  /** Index of the highlighted row (0 when empty; always clamped to the event bounds). */
  readonly selected: number;
  /** Whether the detail pane for the selected event is open. */
  readonly detail: boolean;
  /** How many list rows the viewport can show (drives scrolling; updated on resize). */
  readonly viewportRows: number;
  /** A transient one-line status (e.g. "replaying…", "delivered · 200"); null = nothing to show. */
  readonly status: string | null;
}

/** Upper bound on the events the TUI retains in memory, so a long session against a high-volume endpoint
 *  (or a `--since beginning` backlog) stays bounded like the plain tail. Matches the server lag cap. */
export const MAX_EVENTS = 10_000;

/** A fresh, empty TUI state sized to `viewportRows` list rows. */
export function initialState(viewportRows: number): TuiState {
  return { events: [], selected: 0, detail: false, viewportRows, status: null };
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Append a newly-arrived event. Selection stays put so a live append never yanks the user off the row
 *  they're inspecting (they navigate with the arrows; the list grows beneath them). Over MAX_EVENTS the
 *  oldest rows are dropped (drop-oldest, bounded memory) and the selection shifts by the drop count so it
 *  keeps tracking the same event. */
export function appendEvent(state: TuiState, summary: EventSummary): TuiState {
  const events = [...state.events, summary];
  if (events.length <= MAX_EVENTS) return { ...state, events };
  const drop = events.length - MAX_EVENTS;
  return { ...state, events: events.slice(drop), selected: Math.max(0, state.selected - drop) };
}

/** Move the selection by `delta` rows (negative = up), clamped to the event bounds. */
export function moveSelection(state: TuiState, delta: number): TuiState {
  if (state.events.length === 0) return { ...state, selected: 0 };
  return { ...state, selected: clamp(state.selected + delta, 0, state.events.length - 1) };
}

/** Toggle the detail pane for the selected event. */
export function toggleDetail(state: TuiState): TuiState {
  return { ...state, detail: !state.detail };
}

/** Set (or clear, with null) the transient status line. */
export function setStatus(state: TuiState, status: string | null): TuiState {
  return { ...state, status };
}

/** The currently-selected event, or undefined when the list is empty. */
export function selectedEvent(state: TuiState): EventSummary | undefined {
  return state.events[state.selected];
}

/**
 * The slice of events to draw, scrolled so the selection stays visible. When everything fits, the offset
 * is 0; otherwise the window anchors the selected row to the bottom edge (the list fills upward, like a
 * tail) — a deterministic, stateless rule so the view is a pure function of the selection.
 */
export function visibleWindow(state: TuiState): {
  readonly offset: number;
  readonly items: readonly EventSummary[];
} {
  const n = state.events.length;
  const rows = Math.max(1, state.viewportRows);
  if (n <= rows) return { offset: 0, items: state.events };
  const offset = clamp(state.selected - rows + 1, 0, n - rows);
  return { offset, items: state.events.slice(offset, offset + rows) };
}
