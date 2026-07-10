import { describe, expect, it, vi } from "vitest";

import {
  runRetentionPruneCron,
  type ExpiringEvent,
  type RetentionPruneCronDeps,
} from "../src/retention-prune-cron";

// The retention prune is pure + dependency-injected so it unit-tests with fakes. The load-bearing
// behaviours: it pages each org to exhaustion (bounded per tick), it deletes the R2 payload objects BEFORE
// the event rows (the content-addressed key lives only on the row — delete the row first and the object is
// orphaned forever), and it stays within its per-tick budgets.

/** A fake org→events store the deps read/mutate, so tests assert what actually got pruned. */
function makeStore(seed: Record<string, ExpiringEvent[]>) {
  const store: Record<string, ExpiringEvent[]> = {};
  for (const [org, evs] of Object.entries(seed)) store[org] = [...evs];
  const order: string[] = []; // call trace to assert R2-before-rows ordering
  const deps: RetentionPruneCronDeps = {
    claimOrgs: async (_days, limit) =>
      Object.keys(store)
        .filter((o) => store[o].length > 0)
        .slice(0, limit),
    listExpiring: async (orgId, _days, limit) => store[orgId].slice(0, limit),
    // Default fence: every key is valid. Individual tests override to simulate a poison key.
    validateKey: () => true,
    deleteR2: async (keys) => {
      order.push(`r2:${keys.join(",")}`);
    },
    deleteEvents: async (orgId, ids) => {
      order.push(`rows:${ids.join(",")}`);
      const before = store[orgId].length;
      store[orgId] = store[orgId].filter((e) => !ids.includes(e.id));
      return before - store[orgId].length;
    },
    retentionDays: 7,
    orgLimit: 100,
    batchesPerOrg: 50,
    pageSize: 2,
  };
  return { store, order, deps };
}

const ev = (id: string): ExpiringEvent => ({ id, endpointId: `ep-${id}`, r2Key: `key-${id}` });

describe("runRetentionPruneCron", () => {
  it("prunes every expiring event across orgs, paging each to exhaustion", async () => {
    const { store, deps } = makeStore({
      "org-a": [ev("a1"), ev("a2"), ev("a3")], // 3 events, pageSize 2 → two pages
      "org-b": [ev("b1")],
    });
    const result = await runRetentionPruneCron(deps);
    expect(result).toEqual({ orgs: 2, deleted: 4, fenced: 0 });
    expect(store["org-a"]).toHaveLength(0);
    expect(store["org-b"]).toHaveLength(0);
  });

  it("deletes the R2 objects BEFORE the event rows (crash-orphan safety)", async () => {
    const { order, deps } = makeStore({ "org-a": [ev("a1"), ev("a2")] });
    await runRetentionPruneCron(deps);
    // One full page of 2: R2 delete must precede the row delete.
    expect(order).toEqual(["r2:key-a1,key-a2", "rows:a1,a2"]);
  });

  it("respects the per-org batch budget, leaving the rest for the next tick", async () => {
    const { store, deps } = makeStore({
      "org-a": [ev("a1"), ev("a2"), ev("a3"), ev("a4"), ev("a5"), ev("a6")],
    });
    // pageSize 2, but only ONE batch per org this tick → exactly 2 pruned, 4 remain.
    const result = await runRetentionPruneCron({ ...deps, batchesPerOrg: 1 });
    expect(result.deleted).toBe(2);
    expect(store["org-a"]).toHaveLength(4);
  });

  it("caps the number of orgs serviced per tick", async () => {
    const { deps } = makeStore({
      "org-a": [ev("a1")],
      "org-b": [ev("b1")],
      "org-c": [ev("c1")],
    });
    const claimSpy = vi.fn(deps.claimOrgs);
    const result = await runRetentionPruneCron({ ...deps, orgLimit: 2, claimOrgs: claimSpy });
    expect(claimSpy).toHaveBeenCalledWith(7, 2);
    expect(result.orgs).toBe(2);
  });

  it("does nothing (no R2 or row deletes) when no org has expiring events", async () => {
    const { order, deps } = makeStore({});
    const result = await runRetentionPruneCron(deps);
    expect(result).toEqual({ orgs: 0, deleted: 0, fenced: 0 });
    expect(order).toEqual([]);
  });

  it("FENCES a key that fails the principal check: never deletes its R2 object OR row, and alarms", async () => {
    // "a2" carries a poison (cross-tenant/corrupt) key. It must be skipped entirely — no R2 delete, and its
    // row is LEFT for investigation — while its well-formed sibling "a1" prunes normally.
    const { store, order, deps } = makeStore({ "org-a": [ev("a1"), ev("a2")] });
    const result = await runRetentionPruneCron({
      ...deps,
      validateKey: (_org, _ep, key) => key !== "key-a2",
    });
    expect(result).toEqual({ orgs: 1, deleted: 1, fenced: 1 });
    // Only a1's key reached R2, and only a1's row was deleted; a2 survives.
    expect(order).toEqual(["r2:key-a1", "rows:a1"]);
    expect(store["org-a"].map((e) => e.id)).toEqual(["a2"]);
  });

  it("skips R2 entirely when a whole page is fenced out (no empty delete, no spin)", async () => {
    const { order, deps } = makeStore({ "org-a": [ev("a1"), ev("a2")] });
    const result = await runRetentionPruneCron({ ...deps, validateKey: () => false });
    expect(result).toEqual({ orgs: 1, deleted: 0, fenced: 2 });
    expect(order).toEqual([]); // never called deleteR2 or deleteEvents
  });

  it("never issues an empty R2 delete for a drained org", async () => {
    // A single event, single full-then-empty page: R2 delete fires once, not again on the empty follow-up.
    const { order, deps } = makeStore({ "org-a": [ev("a1")] });
    await runRetentionPruneCron({ ...deps, pageSize: 1 });
    expect(order.filter((o) => o.startsWith("r2:"))).toEqual(["r2:key-a1"]);
  });
});
