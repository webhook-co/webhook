import { describe, expect, it } from "vitest";

import {
  runEventPayloadPurgeCron,
  type EventPayloadPurgeCronDeps,
  type EventPurgeJob,
} from "../src/event-payload-purge-cron";

// The per-event R2 purge drain is pure + DI. Load-bearing behaviours: it deletes the R2 body BEFORE marking
// the job complete (so a crash can't leave a "done" job with its body still present), it fences every stored
// key to its principal before touching R2 (a poisoned/cross-tenant key is skipped + alarmed, never deleted),
// and it is bounded per tick.

function makeDeps(
  jobs: EventPurgeJob[],
  over: Partial<EventPayloadPurgeCronDeps> = {},
): { deps: EventPayloadPurgeCronDeps; deleted: string[]; completed: string[]; order: string[] } {
  const deleted: string[] = [];
  const completed: string[] = [];
  const order: string[] = [];
  const deps: EventPayloadPurgeCronDeps = {
    claim: async (n) => jobs.slice(0, n),
    validateKey: () => true,
    deleteR2: async (key) => {
      deleted.push(key);
      order.push(`r2:${key}`);
    },
    complete: async (eventId) => {
      completed.push(eventId);
      order.push(`done:${eventId}`);
    },
    limit: 100,
    ...over,
  };
  return { deps, deleted, completed, order };
}

const job = (id: string): EventPurgeJob => ({
  eventId: id,
  orgId: `org-${id}`,
  endpointId: `ep-${id}`,
  r2Key: `org/org-${id}/ep/ep-${id}/k`,
});

describe("runEventPayloadPurgeCron", () => {
  it("deletes each job's R2 body then completes it, R2 BEFORE completion", async () => {
    const { deps, deleted, completed, order } = makeDeps([job("a"), job("b")]);
    const res = await runEventPayloadPurgeCron(deps);

    expect(res).toEqual({ purged: 2, fenced: 0 });
    expect(deleted).toEqual(["org/org-a/ep/ep-a/k", "org/org-b/ep/ep-b/k"]);
    expect(completed).toEqual(["a", "b"]);
    // For each job the R2 delete precedes its completion write.
    expect(order).toEqual(["r2:org/org-a/ep/ep-a/k", "done:a", "r2:org/org-b/ep/ep-b/k", "done:b"]);
  });

  it("SKIPS a job whose key fails the principal fence — never deletes it, never completes it", async () => {
    const poison = job("x");
    const { deps, deleted, completed } = makeDeps([poison], {
      // Only the poison key fails the fence.
      validateKey: (_org, _ep, key) => key !== poison.r2Key,
    });
    const res = await runEventPayloadPurgeCron(deps);

    expect(res).toEqual({ purged: 0, fenced: 1 });
    expect(deleted).toEqual([]); // never touched R2
    expect(completed).toEqual([]); // job left for investigation → re-alarms next tick
  });

  it("bounds work by `limit`", async () => {
    const { deps, deleted } = makeDeps([job("a"), job("b"), job("c")], { limit: 2 });
    const res = await runEventPayloadPurgeCron(deps);
    expect(res.purged).toBe(2);
    expect(deleted).toHaveLength(2);
  });

  it("is a clean no-op when there are no jobs", async () => {
    const { deps } = makeDeps([]);
    expect(await runEventPayloadPurgeCron(deps)).toEqual({ purged: 0, fenced: 0 });
  });
});
