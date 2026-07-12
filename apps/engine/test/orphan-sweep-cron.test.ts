import { describe, expect, it, vi } from "vitest";

import {
  runOrphanSweep,
  type OrphanCandidate,
  type OrphanSweepDeps,
} from "../src/orphan-sweep-cron";

// The R2 orphan sweep: delete a payload object ONLY when it is (1) older than the safety window, (2) a
// well-formed key, AND (3) has no `events` row. All three fences must hold — a false delete destroys a
// legitimate event's body. Bounded per tick + cursor-resumed.

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);
const HOUR = 3_600_000;
const SAFETY = 6 * HOUR;

/** A well-formed key (passes the default validKey) with a controllable age. */
function obj(name: string, ageMs: number): OrphanCandidate {
  return { key: `org/o/ep/e/${name}`, uploadedMs: NOW - ageMs };
}

function deps(over: Partial<OrphanSweepDeps> = {}): OrphanSweepDeps {
  return {
    readCursor: vi.fn(async () => null),
    listPage: vi.fn(async () => ({ objects: [], cursor: null })),
    validKey: (key) => key.startsWith("org/o/ep/e/"),
    existingKeys: vi.fn(async () => new Set<string>()), // default: nothing has a row → all are orphans
    deleteR2: vi.fn(async () => undefined),
    deleteEnabled: true,
    writeCursor: vi.fn(async () => undefined),
    now: NOW,
    safetyWindowMs: SAFETY,
    pageSize: 100,
    ...over,
  };
}

describe("runOrphanSweep", () => {
  it("deletes an aged, well-formed object that has NO events row (a true orphan)", async () => {
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      listPage: async () => ({ objects: [obj("aaa", 10 * HOUR)], cursor: "c1" }),
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(r).toMatchObject({ scanned: 1, deleted: 1, skippedYoung: 0, skippedFenced: 0 });
    expect(deleteR2).toHaveBeenCalledWith(["org/o/ep/e/aaa"]);
  });

  it("NEVER deletes an object younger than the safety window (the in-flight PUT→insert guard)", async () => {
    const deleteR2 = vi.fn(async () => undefined);
    const existingKeys = vi.fn(async () => new Set<string>());
    const d = deps({
      listPage: async () => ({ objects: [obj("young", 1 * HOUR)], cursor: null }),
      deleteR2,
      existingKeys,
    });
    const r = await runOrphanSweep(d);
    expect(r).toMatchObject({ scanned: 1, deleted: 0, skippedYoung: 1 });
    expect(deleteR2).not.toHaveBeenCalled();
    expect(existingKeys).not.toHaveBeenCalled(); // young objects never even reach the anti-join
  });

  it("NEVER deletes an object that HAS an events row (anti-join spares it), even when aged", async () => {
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      listPage: async () => ({
        objects: [obj("has-row", 10 * HOUR), obj("orphan", 10 * HOUR)],
        cursor: null,
      }),
      existingKeys: async (keys) => new Set(keys.filter((k) => k.endsWith("has-row"))), // only has-row exists
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(r.deleted).toBe(1);
    expect(deleteR2).toHaveBeenCalledWith(["org/o/ep/e/orphan"]); // only the row-less one
  });

  it("NEVER deletes a malformed/foreign key (prefix fence), and doesn't send it to the anti-join", async () => {
    const existingKeys = vi.fn(async () => new Set<string>());
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      listPage: async () => ({
        objects: [
          { key: "some/other/thing", uploadedMs: NOW - 10 * HOUR }, // fails validKey
          obj("good", 10 * HOUR),
        ],
        cursor: null,
      }),
      existingKeys,
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(r).toMatchObject({ scanned: 2, deleted: 1, skippedFenced: 1 });
    expect(existingKeys).toHaveBeenCalledWith(["org/o/ep/e/good"]); // the foreign key never reached it
    expect(deleteR2).toHaveBeenCalledWith(["org/o/ep/e/good"]);
  });

  it("resumes from the persisted cursor and advances it; does not delete when nothing qualifies", async () => {
    const listPage = vi.fn(async () => ({ objects: [obj("young", 1 * HOUR)], cursor: "next-cur" }));
    const writeCursor = vi.fn(async () => undefined);
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      readCursor: async () => "saved-cur",
      listPage,
      writeCursor,
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(listPage).toHaveBeenCalledWith("saved-cur", 100); // resumed
    expect(writeCursor).toHaveBeenCalledWith("next-cur"); // advanced
    expect(r.exhausted).toBe(false);
    expect(deleteR2).not.toHaveBeenCalled();
  });

  it("marks the scan exhausted and persists a null cursor at the end of the bucket (next tick restarts)", async () => {
    const writeCursor = vi.fn(async () => undefined);
    const d = deps({
      listPage: async () => ({ objects: [obj("aaa", 10 * HOUR)], cursor: null }),
      writeCursor,
    });
    const r = await runOrphanSweep(d);
    expect(r.exhausted).toBe(true);
    expect(writeCursor).toHaveBeenCalledWith(null);
  });

  it("issues NO R2 delete for an all-clean page (no empty-array delete call)", async () => {
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      listPage: async () => ({ objects: [obj("has-row", 10 * HOUR)], cursor: null }),
      existingKeys: async (keys) => new Set(keys), // everything has a row
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(r.deleted).toBe(0);
    expect(deleteR2).not.toHaveBeenCalled();
  });

  it("COUNT-ONLY mode (deleteEnabled=false) reports orphans but deletes NOTHING", async () => {
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      listPage: async () => ({
        objects: [obj("orphan1", 10 * HOUR), obj("orphan2", 10 * HOUR)],
        cursor: null,
      }),
      deleteEnabled: false,
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(r.orphans).toBe(2); // identified…
    expect(r.deleted).toBe(0); // …but not deleted
    expect(deleteR2).not.toHaveBeenCalled();
  });

  it("treats an object EXACTLY at the safety window as old enough (strict-less-than young check)", async () => {
    const deleteR2 = vi.fn(async () => undefined);
    const d = deps({
      // uploaded exactly `safetyWindowMs` ago ⇒ now - uploaded === SAFETY, not < SAFETY ⇒ NOT young.
      listPage: async () => ({ objects: [obj("edge", SAFETY)], cursor: null }),
      deleteR2,
    });
    const r = await runOrphanSweep(d);
    expect(r.skippedYoung).toBe(0);
    expect(r.deleted).toBe(1);
    expect(deleteR2).toHaveBeenCalledWith(["org/o/ep/e/edge"]);
  });
});
