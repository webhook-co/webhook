import { describe, expect, it } from "vitest";

import { advance, INITIAL_STATE, type StreamState } from "./stream-engine";
import { EVENT_POOL, MAX_ROWS, SEED_COUNTER, SEED_ROWS } from "./stream-data";

/** Apply `advance` `n` times from a starting state. */
function advanceN(state: StreamState, n: number): StreamState {
  let s = state;
  for (let i = 0; i < n; i++) s = advance(s);
  return s;
}

describe("stream-engine", () => {
  it("seeds from the static rows and counter", () => {
    expect(INITIAL_STATE.rows).toEqual(SEED_ROWS);
    expect(INITIAL_STATE.counter).toBe(SEED_COUNTER);
    expect(INITIAL_STATE.seq).toBe(0);
  });

  it("prepends the next pooled event, newest first", () => {
    const next = advance(INITIAL_STATE);
    expect(next.rows[0]).toMatchObject({ provider: "linear", event: "issue.updated", id: "evt-1" });
    // The previous newest is pushed down one slot.
    expect(next.rows[1]).toEqual(SEED_ROWS[0]);
  });

  it("increments the counter and cursor by exactly one per advance", () => {
    const next = advance(INITIAL_STATE);
    expect(next.counter).toBe(SEED_COUNTER + 1);
    expect(next.seq).toBe(1);
    const after10 = advanceN(INITIAL_STATE, 10);
    expect(after10.counter).toBe(SEED_COUNTER + 10);
    expect(after10.seq).toBe(10);
  });

  it("evicts the oldest row past MAX_ROWS", () => {
    const after3 = advanceN(INITIAL_STATE, 3);
    expect(after3.rows).toHaveLength(MAX_ROWS);
    // After 5 advances every seed has been pushed off the bottom.
    const after5 = advanceN(INITIAL_STATE, 5);
    expect(after5.rows).toHaveLength(MAX_ROWS);
    expect(after5.rows.some((r) => r.id.startsWith("seed-"))).toBe(false);
  });

  it("produces a deterministic provider/event/id sequence", () => {
    let s = INITIAL_STATE;
    const seen: Array<{ provider: string; event: string; id: string }> = [];
    for (let i = 0; i < 5; i++) {
      s = advance(s);
      const top = s.rows[0];
      seen.push({ provider: top.provider, event: top.event, id: top.id });
    }
    expect(seen).toEqual([
      { provider: "linear", event: "issue.updated", id: "evt-1" },
      { provider: "vercel", event: "deployment.ready", id: "evt-2" },
      { provider: "twilio", event: "message.received", id: "evt-3" },
      { provider: "slack", event: "event.callback", id: "evt-4" },
      { provider: "stripe", event: "charge.refunded", id: "evt-5" },
    ]);
  });

  it("fails verification on exactly the one pooled entry per pass, with the baked reason", () => {
    // One full pass through the pool: exactly one failure, the stripe charge.refunded entry.
    let s = INITIAL_STATE;
    const failures: Array<{ provider: string; reason: string }> = [];
    for (let i = 0; i < EVENT_POOL.length; i++) {
      s = advance(s);
      const top = s.rows[0];
      if (!top.status.ok) failures.push({ provider: top.provider, reason: top.status.reason });
    }
    expect(failures).toEqual([{ provider: "stripe", reason: "raw_body_modified" }]);
  });

  it("wraps the pool cursor without drift", () => {
    const oncePast = advanceN(INITIAL_STATE, EVENT_POOL.length + 1);
    // After a full pass + 1, the newest row is the pool's first entry again, with a fresh id.
    expect(oncePast.rows[0]).toMatchObject({
      provider: "linear",
      id: `evt-${EVENT_POOL.length + 1}`,
    });
  });

  it("never mutates the input state", () => {
    const before = INITIAL_STATE;
    const snapshotRows = before.rows;
    const snapshotCounter = before.counter;
    advance(before);
    expect(before.rows).toBe(snapshotRows);
    expect(before.counter).toBe(snapshotCounter);
    expect(before.seq).toBe(0);
  });

  it("assigns unique, monotonic ids to appended rows", () => {
    const after = advanceN(INITIAL_STATE, MAX_ROWS);
    const ids = after.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["evt-5", "evt-4", "evt-3", "evt-2", "evt-1"]);
  });
});
