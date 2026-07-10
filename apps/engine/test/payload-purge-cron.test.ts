import { describe, expect, it } from "vitest";

import {
  runPayloadPurgeCron,
  type PayloadPurgeCronDeps,
  type PurgeBucket,
  type PurgeJob,
} from "../src/payload-purge-cron";

/**
 * A fake R2 bucket with the real key-cursor semantics: `list` returns keys strictly AFTER the
 * cursor (the cursor is the last key of the previous page), so deleting a listed page never makes a
 * later `list(cursor)` skip surviving objects. Records deletes so tests can assert what was purged.
 */
function fakeBucket(initialKeys: string[]) {
  let keys = [...initialKeys];
  const deleted: string[] = [];
  const bucket: PurgeBucket = {
    list: async ({ prefix, cursor, limit = 1000 }) => {
      const matching = keys.filter((k) => k.startsWith(prefix)).sort();
      const rest = matching.filter((k) => (cursor ? k > cursor : true));
      const page = rest.slice(0, limit);
      const truncated = page.length < rest.length;
      return {
        objects: page.map((k) => ({ key: k })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
    delete: async (ks) => {
      keys = keys.filter((k) => !ks.includes(k));
      deleted.push(...ks);
    },
  };
  return { bucket, deleted, remaining: () => keys.length };
}

/** Records every advance() call and mirrors done→drop so a re-claim wouldn't return a finished job. */
function recordingAdvance() {
  const calls: Array<{
    orgId: string;
    cursor: string | null;
    deltaObjects: number;
    done: boolean;
  }> = [];
  return {
    calls,
    advance: async (input: {
      orgId: string;
      cursor: string | null;
      deltaObjects: number;
      done: boolean;
    }) => {
      calls.push(input);
    },
  };
}

function deps(jobs: PurgeJob[], over: Partial<PayloadPurgeCronDeps> = {}): PayloadPurgeCronDeps {
  return {
    claim: async (n) => jobs.slice(0, n),
    bucket: fakeBucket([]).bucket,
    advance: async () => {},
    jobLimit: 10,
    batchesPerJob: 100,
    pageSize: 1000,
    log: () => {},
    ...over,
  };
}

const keysFor = (orgId: string, n: number) =>
  Array.from({ length: n }, (_, i) => `org/${orgId}/ep/e1/${String(i).padStart(6, "0")}`);

describe("runPayloadPurgeCron", () => {
  it("purges a small org in a single batch and marks it completed", async () => {
    const fb = fakeBucket(keysFor("o1", 3));
    const adv = recordingAdvance();
    const res = await runPayloadPurgeCron(
      deps([{ orgId: "o1", cursor: null }], { bucket: fb.bucket, advance: adv.advance }),
    );
    expect(res).toEqual({ jobs: 1, deleted: 3, completed: 1 });
    expect(fb.remaining()).toBe(0);
    expect(adv.calls).toEqual([{ orgId: "o1", cursor: null, deltaObjects: 3, done: true }]);
  });

  it("purges a large org across multiple batches within one tick, deleting every object", async () => {
    const fb = fakeBucket(keysFor("o1", 2500));
    const adv = recordingAdvance();
    const res = await runPayloadPurgeCron(
      deps([{ orgId: "o1", cursor: null }], {
        bucket: fb.bucket,
        advance: adv.advance,
        pageSize: 1000,
      }),
    );
    expect(fb.remaining()).toBe(0);
    expect(fb.deleted.length).toBe(2500);
    expect(res.deleted).toBe(2500);
    expect(res.completed).toBe(1);
    // Three batches: 1000, 1000, 500 — the last one done.
    expect(adv.calls.map((c) => c.deltaObjects)).toEqual([1000, 1000, 500]);
    expect(adv.calls.at(-1)?.done).toBe(true);
  });

  it("respects the per-tick batch budget: leaves the rest for the next tick with a saved cursor", async () => {
    const fb = fakeBucket(keysFor("o1", 2500));
    const adv = recordingAdvance();
    const res = await runPayloadPurgeCron(
      deps([{ orgId: "o1", cursor: null }], {
        bucket: fb.bucket,
        advance: adv.advance,
        pageSize: 1000,
        batchesPerJob: 2, // only two pages this tick
      }),
    );
    expect(res.completed).toBe(0); // not finished
    expect(fb.deleted.length).toBe(2000);
    expect(fb.remaining()).toBe(500);
    const last = adv.calls.at(-1);
    expect(last?.done).toBe(false);
    expect(last?.cursor).not.toBeNull(); // a resume point was saved
  });

  it("resumes from a saved cursor without re-deleting earlier pages", async () => {
    // Simulate a job already half-drained: keys 0..999 gone, cursor at the 999th key.
    const remaining = keysFor("o1", 2000).slice(1000);
    const fb = fakeBucket(remaining);
    const adv = recordingAdvance();
    const resumeCursor = `org/o1/ep/e1/${String(999).padStart(6, "0")}`;
    await runPayloadPurgeCron(
      deps([{ orgId: "o1", cursor: resumeCursor }], { bucket: fb.bucket, advance: adv.advance }),
    );
    expect(fb.remaining()).toBe(0);
    expect(fb.deleted.length).toBe(1000);
  });

  it("completes an already-empty prefix (nothing to delete) in one batch", async () => {
    const fb = fakeBucket([]);
    const adv = recordingAdvance();
    const res = await runPayloadPurgeCron(
      deps([{ orgId: "gone", cursor: null }], { bucket: fb.bucket, advance: adv.advance }),
    );
    expect(res).toEqual({ jobs: 1, deleted: 0, completed: 1 });
    expect(adv.calls).toEqual([{ orgId: "gone", cursor: null, deltaObjects: 0, done: true }]);
  });

  it("drains multiple jobs and only touches each org's own prefix", async () => {
    const fb = fakeBucket([...keysFor("o1", 2), ...keysFor("o2", 3)]);
    const adv = recordingAdvance();
    const res = await runPayloadPurgeCron(
      deps(
        [
          { orgId: "o1", cursor: null },
          { orgId: "o2", cursor: null },
        ],
        {
          bucket: fb.bucket,
          advance: adv.advance,
        },
      ),
    );
    expect(res.jobs).toBe(2);
    expect(res.completed).toBe(2);
    expect(res.deleted).toBe(5);
    expect(fb.remaining()).toBe(0);
    expect(fb.deleted.every((k) => k.startsWith("org/o1/") || k.startsWith("org/o2/"))).toBe(true);
  });

  it("honors the job limit per tick", async () => {
    let claimedN = 0;
    await runPayloadPurgeCron(
      deps([], {
        jobLimit: 5,
        claim: async (n) => {
          claimedN = n;
          return [];
        },
      }),
    );
    expect(claimedN).toBe(5);
  });
});
