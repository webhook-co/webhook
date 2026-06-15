/**
 * The pure core of the live-inspector stage. No React, no timers, no DOM — just a reducer that
 * advances a deterministic event stream. Keeping the logic here (and out of the hook) is what makes
 * the eviction / counter / fail-cadence behaviour exhaustively unit-testable.
 */

import { EVENT_POOL, MAX_ROWS, SEED_COUNTER, SEED_ROWS, type StreamRow } from "./stream-data";

export interface StreamState {
  /** Visible rows, newest first, length ≤ MAX_ROWS. */
  rows: readonly StreamRow[];
  /** Total events seen — the running counter in the UI. */
  counter: number;
  /** Monotonic cursor into EVENT_POOL; also seeds each appended row's id. Drives determinism. */
  seq: number;
}

/** The frozen starting point — the seed rows the SSR HTML and first client render both paint. */
export const INITIAL_STATE: StreamState = { rows: SEED_ROWS, counter: SEED_COUNTER, seq: 0 };

/**
 * Append the next pooled event to the top, evict past MAX_ROWS, and bump the counter. Pure: the input
 * state is never mutated. Given the cursor, the next row is fully determined, so `advance` applied N
 * times from a known state yields a fixed sequence (asserted in the tests).
 */
export function advance(state: StreamState): StreamState {
  // The modulo keeps the index in range, so the lookup is always defined.
  const template = EVENT_POOL[state.seq % EVENT_POOL.length]!;
  const row: StreamRow = { ...template, id: `evt-${state.seq + 1}` };
  return {
    rows: [row, ...state.rows].slice(0, MAX_ROWS),
    counter: state.counter + 1,
    seq: state.seq + 1,
  };
}
