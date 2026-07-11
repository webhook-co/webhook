import { describe, expect, it, vi } from "vitest";

import {
  isTotalRetentionFailure,
  runRetentionPruneCron,
  type ExpiringEvent,
  type RetentionPruneCronDeps,
  type RetentionPruneCronResult,
} from "../src/retention-prune-cron";

// The retention prune is pure + dependency-injected so it unit-tests with fakes. The load-bearing
// behaviours: it pages each org to exhaustion (bounded per tick), it deletes the event ROWS first then
// purges R2 for only the ids the delete returned (so an entitlement flip mid-tick never destroys a paying
// org's bodies), it fences each key to its principal before touching R2, and it stays within its budgets.

/** A fake org→events store the deps read/mutate, so tests assert what actually got pruned. */
function makeStore(seed: Record<string, ExpiringEvent[]>) {
  const store: Record<string, ExpiringEvent[]> = {};
  for (const [org, evs] of Object.entries(seed)) store[org] = [...evs];
  const order: string[] = []; // call trace to assert R2-before-rows ordering
  const deps: RetentionPruneCronDeps = {
    claimOrgs: async (limit) =>
      Object.keys(store)
        .filter((o) => store[o].length > 0)
        .slice(0, limit),
    listExpiring: async (orgId, limit) => store[orgId].slice(0, limit),
    // Default fence: every key is valid. Individual tests override to simulate a poison key.
    validateKey: () => true,
    deleteR2: async (keys) => {
      order.push(`r2:${keys.join(",")}`);
    },
    deleteEvents: async (orgId, ids) => {
      order.push(`rows:${ids.join(",")}`);
      const present = store[orgId].filter((e) => ids.includes(e.id)).map((e) => e.id);
      store[orgId] = store[orgId].filter((e) => !ids.includes(e.id));
      return present; // the ids actually removed (all present ones, in this fake)
    },
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
    expect(result).toEqual({ orgs: 2, deleted: 4, fenced: 0, failed: 0 });
    expect(store["org-a"]).toHaveLength(0);
    expect(store["org-b"]).toHaveLength(0);
  });

  it("deletes the rows BEFORE R2, and only purges R2 for ids the DELETE actually removed", async () => {
    const { order, deps } = makeStore({ "org-a": [ev("a1"), ev("a2")] });
    await runRetentionPruneCron(deps);
    // Rows first (atomic age+entitlement re-check), then R2 for exactly the deleted ids.
    expect(order).toEqual(["rows:a1,a2", "r2:key-a1,key-a2"]);
  });

  it("PURGES R2 only for the ids the DELETE returned — an entitlement flip mid-tick spares that org's bodies", async () => {
    // deleteEvents returns FEWER ids than asked (the DB anti-join spared a2 because the org became entitled
    // between listing and deleting). a2's R2 body must NOT be deleted.
    const { order, deps } = makeStore({ "org-a": [ev("a1"), ev("a2")] });
    const result = await runRetentionPruneCron({
      ...deps,
      batchesPerOrg: 1, // one pass — the fake DELETE doesn't mutate the store
      deleteEvents: async (_org, _ids) => ["a1"], // only a1 was actually deleted
    });
    expect(result.deleted).toBe(1);
    // Only a1's body was purged from R2; a2 (spared by the DELETE) is untouched.
    expect(order.filter((o) => o.startsWith("r2:"))).toEqual(["r2:key-a1"]);
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
    expect(claimSpy).toHaveBeenCalledWith(2);
    expect(result.orgs).toBe(2);
  });

  it("does nothing (no R2 or row deletes) when no org has expiring events", async () => {
    const { order, deps } = makeStore({});
    const result = await runRetentionPruneCron(deps);
    expect(result).toEqual({ orgs: 0, deleted: 0, fenced: 0, failed: 0 });
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
    expect(result).toEqual({ orgs: 1, deleted: 1, fenced: 1, failed: 0 });
    // Only a1's row was deleted (a2 never entered the delete), then only a1's key reached R2; a2 survives.
    expect(order).toEqual(["rows:a1", "r2:key-a1"]);
    expect(store["org-a"].map((e) => e.id)).toEqual(["a2"]);
  });

  it("skips R2 entirely when a whole page is fenced out (no empty delete, no spin)", async () => {
    const { order, deps } = makeStore({ "org-a": [ev("a1"), ev("a2")] });
    const result = await runRetentionPruneCron({ ...deps, validateKey: () => false });
    expect(result).toEqual({ orgs: 1, deleted: 0, fenced: 2, failed: 0 });
    expect(order).toEqual([]); // never called deleteR2 or deleteEvents
  });

  it("never issues an empty R2 delete for a drained org", async () => {
    // A single event, single full-then-empty page: R2 delete fires once, not again on the empty follow-up.
    const { order, deps } = makeStore({ "org-a": [ev("a1")] });
    await runRetentionPruneCron({ ...deps, pageSize: 1 });
    expect(order.filter((o) => o.startsWith("r2:"))).toEqual(["r2:key-a1"]);
  });

  it("processes orgs with BOUNDED concurrency (never more than orgConcurrency in flight, all drained)", async () => {
    // S5: the outer org loop runs a bounded pool so a large backlog drains within the 15-min cron wall time
    // instead of 50 orgs strictly sequential. Instrument listExpiring to record peak concurrent orgs.
    const { store, deps } = makeStore({
      "org-a": [ev("a1")],
      "org-b": [ev("b1")],
      "org-c": [ev("c1")],
      "org-d": [ev("d1")],
      "org-e": [ev("e1")],
    });
    let inFlight = 0;
    let peak = 0;
    const base = deps.listExpiring;
    const listExpiring: RetentionPruneCronDeps["listExpiring"] = async (orgId, limit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield across several microtasks so sibling orgs in the pool actually overlap this one.
      await Promise.resolve();
      await Promise.resolve();
      const page = await base(orgId, limit);
      inFlight--;
      return page;
    };
    const result = await runRetentionPruneCron({ ...deps, orgConcurrency: 2, listExpiring });
    expect(peak).toBeLessThanOrEqual(2); // never exceeds the bound
    expect(peak).toBeGreaterThan(1); // and concurrency actually happens (not accidentally sequential)
    expect(result.orgs).toBe(5);
    expect(result.deleted).toBe(5); // every org still fully drained
    for (const o of ["org-a", "org-b", "org-c", "org-d", "org-e"]) {
      expect(store[o]).toHaveLength(0);
    }
  });

  it("ISOLATES a failing org — the others still prune and the failure is counted (not sunk)", async () => {
    // Concurrency requires per-org isolation: one org's DB/R2 fault must not abort the whole pass (which,
    // under a naive Promise.all, would drop every sibling's result). The failed org is left for next tick.
    const { store, deps } = makeStore({
      "org-a": [ev("a1")],
      "org-b": [ev("b1")],
      "org-c": [ev("c1")],
    });
    const base = deps.deleteEvents;
    const deleteEvents: RetentionPruneCronDeps["deleteEvents"] = async (orgId, ids) => {
      if (orgId === "org-b") throw new Error("hyperdrive blip");
      return base(orgId, ids);
    };
    const result = await runRetentionPruneCron({ ...deps, orgConcurrency: 2, deleteEvents });
    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(2); // a + c pruned
    expect(store["org-a"]).toHaveLength(0);
    expect(store["org-c"]).toHaveLength(0);
    expect(store["org-b"]).toHaveLength(1); // b's delete threw → its row survives for the next tick
  });

  it("counts partial progress when an org faults in a LATER batch (earlier deletions stay + are counted)", async () => {
    // org-a has 4 events over 2 pages (pageSize 2). The 1st batch deletes a1,a2; the 2nd batch's deleteEvents
    // throws. The already-committed 2 deletions must still be counted, the org counted `failed` exactly once,
    // and its remaining rows left for the next tick — the partial-progress invariant the comments rely on.
    const { store, deps } = makeStore({ "org-a": [ev("a1"), ev("a2"), ev("a3"), ev("a4")] });
    let call = 0;
    const base = deps.deleteEvents;
    const deleteEvents: RetentionPruneCronDeps["deleteEvents"] = async (orgId, ids) => {
      call += 1;
      if (call === 2) throw new Error("blip on the second batch");
      return base(orgId, ids);
    };
    const result = await runRetentionPruneCron({ ...deps, pageSize: 2, deleteEvents });
    expect(result).toEqual({ orgs: 1, deleted: 2, fenced: 0, failed: 1 });
    expect(store["org-a"].map((e) => e.id)).toEqual(["a3", "a4"]); // the un-deleted tail survives
  });

  it("isolates a deleteR2 fault too (rows gone, R2 orphan) — counted, siblings unaffected", async () => {
    const { store, deps } = makeStore({ "org-a": [ev("a1")], "org-b": [ev("b1")] });
    const base = deps.deleteR2;
    const deleteR2: RetentionPruneCronDeps["deleteR2"] = async (keys) => {
      if (keys.includes("key-a1")) throw new Error("r2 delete failed");
      return base(keys);
    };
    const result = await runRetentionPruneCron({ ...deps, orgConcurrency: 2, deleteR2 });
    expect(result.failed).toBe(1); // org-a's R2 delete threw (its rows are already gone — a benign orphan)
    expect(result.deleted).toBe(1); // the delete of a1's ROW succeeded before R2 threw, so it's counted
    expect(store["org-a"]).toHaveLength(0); // rows deleted
    expect(store["org-b"]).toHaveLength(0); // sibling unaffected
  });

  it("defaults to SEQUENTIAL (orgConcurrency omitted) — never more than one org in flight", async () => {
    const { deps } = makeStore({ "org-a": [ev("a1")], "org-b": [ev("b1")], "org-c": [ev("c1")] });
    let inFlight = 0;
    let peak = 0;
    const base = deps.listExpiring;
    const listExpiring: RetentionPruneCronDeps["listExpiring"] = async (orgId, limit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      const page = await base(orgId, limit);
      inFlight--;
      return page;
    };
    const result = await runRetentionPruneCron({ ...deps, listExpiring }); // no orgConcurrency
    expect(peak).toBe(1); // strictly sequential by default (no behavior change for existing callers)
    expect(result.deleted).toBe(3);
  });

  it("under concurrency, a FENCED (poison-key) org never leaks into a clean sibling", async () => {
    // org-poison's key fails the principal fence; org-clean's is fine. Running them concurrently, the poison
    // must skip BOTH deletes and leave its row (fenced+1), while the clean org prunes fully — no cross-org
    // contamination of the fence decision or the deleted set.
    const { store, order, deps } = makeStore({
      "org-poison": [ev("p1")],
      "org-clean": [ev("c1")],
    });
    const result = await runRetentionPruneCron({
      ...deps,
      orgConcurrency: 2,
      validateKey: (_org, _ep, key) => key !== "key-p1",
    });
    expect(result).toEqual({ orgs: 2, deleted: 1, fenced: 1, failed: 0 });
    expect(store["org-poison"].map((e) => e.id)).toEqual(["p1"]); // poison row left for investigation
    expect(store["org-clean"]).toHaveLength(0); // clean org fully pruned
    // The poison key never reached R2 (only the clean key did).
    expect(order.filter((o) => o.startsWith("r2:"))).toEqual(["r2:key-c1"]);
  });
});

// The compliance-critical escalation the engine wrapper (runRetentionPruneDrainCron) throws on. It is the
// ONLY signal that distinguishes a benign partial failure (heal-next-tick) from a total outage that must
// page — so it gets its own coverage rather than riding on the wrapper (which wires un-testable real deps).
describe("isTotalRetentionFailure", () => {
  const result = (over: Partial<RetentionPruneCronResult>): RetentionPruneCronResult => ({
    orgs: 0,
    deleted: 0,
    fenced: 0,
    failed: 0,
    ...over,
  });

  it("is TRUE only when every claimed org faulted (a total outage → escalate)", () => {
    expect(isTotalRetentionFailure(result({ orgs: 3, failed: 3 }))).toBe(true);
    expect(isTotalRetentionFailure(result({ orgs: 1, failed: 1 }))).toBe(true);
  });

  it("is FALSE for a partial failure (healthy orgs' deletions are valid — don't page)", () => {
    expect(isTotalRetentionFailure(result({ orgs: 3, failed: 1 }))).toBe(false);
    expect(isTotalRetentionFailure(result({ orgs: 3, failed: 2, deleted: 5 }))).toBe(false);
  });

  it("is FALSE for a fully-healthy run and for a no-op (zero orgs claimed is not a failure)", () => {
    expect(isTotalRetentionFailure(result({ orgs: 3, failed: 0, deleted: 9 }))).toBe(false);
    expect(isTotalRetentionFailure(result({ orgs: 0, failed: 0 }))).toBe(false);
  });

  it("flags a REAL total-outage run and clears a partial one (driven through the cron, not hand-built)", async () => {
    const total = await runRetentionPruneCron({
      ...makeStore({ "org-a": [ev("a1")], "org-b": [ev("b1")] }).deps,
      orgConcurrency: 2,
      deleteEvents: async () => {
        throw new Error("role grant revoked"); // EVERY org faults
      },
    });
    expect(total).toMatchObject({ orgs: 2, failed: 2, deleted: 0 });
    expect(isTotalRetentionFailure(total)).toBe(true);

    const partial = await runRetentionPruneCron({
      ...makeStore({ "org-a": [ev("a1")], "org-b": [ev("b1")] }).deps,
      orgConcurrency: 2,
      deleteEvents: async (orgId, ids) => {
        if (orgId === "org-a") throw new Error("one org blip");
        return ids; // org-b deletes fine
      },
    });
    expect(partial).toMatchObject({ orgs: 2, failed: 1 });
    expect(isTotalRetentionFailure(partial)).toBe(false);
  });
});
