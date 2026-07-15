import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  makeTerminateAction,
  startTunnelHeartbeat,
} from "./tunnel-heartbeat.js";

// A controllable clock + single captured interval callback — invoke `tick()` to simulate the timer firing
// and `advance(ms)` to move the injected clock, so the state machine is tested without real timers.
function fakeTimers() {
  let cb: (() => void) | undefined;
  let cleared = 0;
  let t = 0;
  return {
    timers: {
      setInterval: (fn: () => void) => {
        cb = fn;
        return "handle" as unknown;
      },
      clearInterval: () => {
        cleared += 1;
      },
      now: () => t,
    },
    tick: () => cb?.(),
    advance: (ms: number) => {
      t += ms;
    },
    get clearedCount() {
      return cleared;
    },
  };
}

const actions = () => {
  const pings: number[] = [];
  const terms: number[] = [];
  return { pings, terms, ping: () => void pings.push(1), terminate: () => void terms.push(1) };
};

describe("startTunnelHeartbeat", () => {
  it("pings on each interval while the socket stays fresh (keeps it warm)", () => {
    const f = fakeTimers();
    const a = actions();
    startTunnelHeartbeat(f.timers, a, { intervalMs: 20_000, timeoutMs: 50_000 });
    f.advance(20_000);
    f.tick(); // 20s, within timeout → ping
    f.advance(20_000);
    f.tick(); // 40s, still within timeout → ping
    expect(a.pings.length).toBe(2);
    expect(a.terms.length).toBe(0);
  });

  it("terminates the socket when nothing arrives within the timeout (dead/half-open detection)", () => {
    const f = fakeTimers();
    const a = actions();
    startTunnelHeartbeat(f.timers, a, { intervalMs: 20_000, timeoutMs: 50_000 });
    f.advance(51_000);
    f.tick(); // 51s of silence (> 50s) → declare dead, terminate (the reconnect loop then recovers)
    expect(a.terms).toEqual([1]);
    expect(a.pings).toEqual([]); // it terminates instead of pinging a dead socket
  });

  it("onActivity resets the deadline — a live socket is NEVER terminated", () => {
    const f = fakeTimers();
    const a = actions();
    const hb = startTunnelHeartbeat(f.timers, a, { intervalMs: 20_000, timeoutMs: 50_000 });
    f.advance(45_000);
    hb.onActivity(); // activity at 45s resets lastActivity
    f.advance(20_000);
    f.tick(); // now 65s, but only 20s since activity → still alive → ping, no terminate
    expect(a.terms).toEqual([]);
    expect(a.pings).toEqual([1]);
  });

  it("stop() clears the interval (a real timer then never fires again) and is idempotent", () => {
    const f = fakeTimers();
    const a = actions();
    const hb = startTunnelHeartbeat(f.timers, a, { intervalMs: 20_000, timeoutMs: 50_000 });
    hb.stop();
    expect(f.clearedCount).toBe(1); // interval cleared → the callback can't fire again in production
    hb.stop(); // idempotent — no double clear
    expect(f.clearedCount).toBe(1);
  });

  it("defaults keep the ping well inside the timeout (warm-before-dead)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(HEARTBEAT_TIMEOUT_MS);
  });
});

describe("makeTerminateAction", () => {
  it("calls terminate and does NOT synthesize a close on the normal path", () => {
    let synthesized = 0;
    const term = makeTerminateAction(
      () => {}, // terminate succeeds (the socket will emit its own 'close')
      () => void (synthesized += 1),
    );
    term();
    expect(synthesized).toBe(0);
  });

  it("synthesizes a close when terminate() throws before emitting one (anti-hang)", () => {
    let synthesized = 0;
    const term = makeTerminateAction(
      () => {
        throw new Error("socket already destroying");
      },
      () => void (synthesized += 1),
    );
    term();
    expect(synthesized).toBe(1); // the connection promise still settles → reconnect isn't wedged
  });
});
