import { describe, expect, it } from "vitest";

import { runOrgReaperCron, type OrgReaperCronDeps } from "../src/org-reaper-cron";

const CHUNK = 100;

/**
 * A fake reaper backend: each org has a bag of `events` (a count). `reapChunk` deletes up to CHUNK and
 * returns how many; `finalize` drops the org (only when its events are already drained — a real reaper only
 * finalizes after a short chunk). `claim` returns the not-yet-finalized orgs, oldest first.
 */
function fakeReaper(seed: Record<string, number>, opts: { chunk?: number } = {}) {
  const chunk = opts.chunk ?? CHUNK;
  const events = new Map(Object.entries(seed));
  const order = Object.keys(seed); // insertion order = oldest first
  const finalized = new Set<string>();
  const deps: OrgReaperCronDeps = {
    jobLimit: 10,
    chunksPerJob: 5,
    chunkSize: chunk,
    claim: async (n) => order.filter((o) => !finalized.has(o)).slice(0, n),
    reapChunk: async (orgId) => {
      const remaining = events.get(orgId) ?? 0;
      const n = Math.min(chunk, remaining);
      events.set(orgId, remaining - n);
      return n;
    },
    finalize: async (orgId) => {
      if (finalized.has(orgId)) return false; // idempotent
      finalized.add(orgId);
      return true;
    },
  };
  return { deps, events, finalized };
}

describe("runOrgReaperCron (#665)", () => {
  it("drains a small org in one tick and finalizes it", async () => {
    const { deps, events, finalized } = fakeReaper({ orgA: 3 });
    const res = await runOrgReaperCron(deps);
    expect(res).toEqual({ orgs: 1, deleted: 3, finalized: 1 });
    expect(events.get("orgA")).toBe(0);
    expect(finalized.has("orgA")).toBe(true);
  });

  it("finalizes an already-empty org (no events) in one short chunk", async () => {
    const { deps, finalized } = fakeReaper({ orgEmpty: 0 });
    const res = await runOrgReaperCron(deps);
    expect(res).toEqual({ orgs: 1, deleted: 0, finalized: 1 });
    expect(finalized.has("orgEmpty")).toBe(true);
  });

  it("does NOT finalize an org that hits the per-tick chunk budget — it resumes next tick", async () => {
    // chunk 2, chunksPerJob 5 → at most 10 events/tick. Seed 25 → drains over 3 ticks, finalizing only when a
    // chunk comes up SHORT (the cron can't know the table is empty until a chunk returns < chunkSize).
    const { deps, events, finalized } = fakeReaper({ big: 25 }, { chunk: 2 });
    deps.chunksPerJob = 5;

    const t1 = await runOrgReaperCron(deps);
    expect(t1).toEqual({ orgs: 1, deleted: 10, finalized: 0 }); // 5 full chunks, budget hit, still deleting
    expect(events.get("big")).toBe(15);
    expect(finalized.has("big")).toBe(false);

    await runOrgReaperCron(deps); // t2: another 10 → 5 left
    expect(events.get("big")).toBe(5);
    expect(finalized.has("big")).toBe(false);

    const t3 = await runOrgReaperCron(deps); // t3: 2, 2, 1(short) → drained → finalize
    expect(events.get("big")).toBe(0);
    expect(t3).toEqual({ orgs: 1, deleted: 5, finalized: 1 });
    expect(finalized.has("big")).toBe(true);
  });

  it("works several orgs in one tick, oldest first, up to jobLimit", async () => {
    const { deps, finalized } = fakeReaper({ a: 1, b: 0, c: 5 });
    deps.jobLimit = 2; // only the two oldest this tick
    const res = await runOrgReaperCron(deps);
    expect(res.orgs).toBe(2);
    expect(finalized.has("a")).toBe(true);
    expect(finalized.has("b")).toBe(true);
    expect(finalized.has("c")).toBe(false); // beyond the jobLimit this tick
  });
});
