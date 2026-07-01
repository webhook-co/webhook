import { describe, expect, it } from "vitest";

import {
  runReconcileCron,
  type ReconcileCronDeps,
  type DueDestination,
} from "../src/reconcile-cron";

function dst(orgId: string, destinationId: string): DueDestination {
  return { orgId, destinationId };
}

/** Records every (orgId, destinationId) wake, and optionally throws for a chosen destination. */
function recordingWaker(failFor: string[] = []) {
  const woke: Array<{ orgId: string; destinationId: string }> = [];
  return {
    woke,
    wake: async (orgId: string, destinationId: string) => {
      if (failFor.includes(destinationId)) throw new Error("wake boom");
      woke.push({ orgId, destinationId });
    },
  };
}

function deps(due: DueDestination[], over: Partial<ReconcileCronDeps> = {}): ReconcileCronDeps {
  return {
    listDue: async () => due,
    wake: async () => {},
    limit: 1000,
    log: () => {},
    ...over,
  };
}

describe("runReconcileCron", () => {
  it("wakes the DO of every due destination, passing its org id", async () => {
    const waker = recordingWaker();
    const due = [dst("o1", "d1"), dst("o1", "d2"), dst("o2", "d3")];
    const res = await runReconcileCron(deps(due, { wake: waker.wake }));
    expect(waker.woke).toEqual([
      { orgId: "o1", destinationId: "d1" },
      { orgId: "o1", destinationId: "d2" },
      { orgId: "o2", destinationId: "d3" },
    ]);
    expect(res.woken).toBe(3);
  });

  it("does nothing when there is no due work", async () => {
    const waker = recordingWaker();
    const res = await runReconcileCron(deps([], { wake: waker.wake }));
    expect(waker.woke).toHaveLength(0);
    expect(res.woken).toBe(0);
    expect(res.failed).toBe(0);
  });

  it("a single failed wake is logged + counted, and never blocks the other wakes", async () => {
    const waker = recordingWaker(["d2"]);
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const due = [dst("o1", "d1"), dst("o1", "d2"), dst("o1", "d3")];
    const res = await runReconcileCron(
      deps(due, { wake: waker.wake, log: (message, fields) => logs.push({ message, fields }) }),
    );
    // d1 + d3 still woke despite d2 throwing.
    expect(waker.woke.map((w) => w.destinationId)).toEqual(["d1", "d3"]);
    expect(res.woken).toBe(2);
    expect(res.failed).toBe(1);
    expect(logs.some((l) => l.message === "reconcile.wake_failed")).toBe(true);
  });

  it("flags (and logs) a capped pass when due work meets the limit — no silent truncation", async () => {
    const waker = recordingWaker();
    const logs: string[] = [];
    const due = [dst("o1", "d1"), dst("o1", "d2")];
    const res = await runReconcileCron(
      deps(due, { wake: waker.wake, limit: 2, log: (m) => logs.push(m) }),
    );
    expect(res.capped).toBe(true);
    expect(logs).toContain("reconcile.capped");
  });

  it("does not flag capped when due work is below the limit", async () => {
    const res = await runReconcileCron(deps([dst("o1", "d1")], { limit: 2 }));
    expect(res.capped).toBe(false);
  });

  it("wakes a large due-set in BOUNDED batches (never one unbounded fan-out)", async () => {
    // 60 due destinations must all wake, but never more than the concurrency window in flight at once —
    // so a capped pass can't blow the Workers per-invocation subrequest ceiling.
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const wake = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); // yield so a whole batch is concurrently in flight before any resolves
      completed++;
      inFlight--;
    };
    const due = Array.from({ length: 60 }, (_, i) => dst("o1", `d${i}`));
    const res = await runReconcileCron(deps(due, { wake, limit: 1000 }));
    expect(res.woken).toBe(60);
    expect(completed).toBe(60);
    // Bounded: the peak concurrency is capped (and strictly below the total, proving batching happened).
    expect(maxInFlight).toBeLessThanOrEqual(25);
    expect(maxInFlight).toBeLessThan(60);
  });
});
