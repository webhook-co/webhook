import { anchorR2Key, importAuditKey, verifyAnchor } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { runAnchorCron, type AnchorCronDeps, type AnchorHead } from "../src/anchor-cron";

const key = () => importAuditKey(new Uint8Array(32).fill(3));

function head(seq: number): AnchorHead {
  return { orgId: crypto.randomUUID(), seq, rowHash: new Uint8Array(32).fill(seq) };
}

/** A Map-backed fake of the R2 create-only put the cron uses. */
function fakeR2(preexisting: string[] = []) {
  const store = new Map<string, string>(preexisting.map((k) => [k, "{}"]));
  return {
    store,
    putAnchorIfAbsent: async (k: string, body: string) => {
      if (store.has(k)) return false;
      store.set(k, body);
      return true;
    },
  };
}

async function deps(
  heads: readonly AnchorHead[],
  r2: ReturnType<typeof fakeR2>,
  over: Partial<AnchorCronDeps> = {},
): Promise<AnchorCronDeps> {
  return {
    readHeads: async () => heads,
    putAnchorIfAbsent: r2.putAnchorIfAbsent,
    key: await key(),
    now: 1_700_000_000_000,
    ...over,
  };
}

describe("runAnchorCron", () => {
  it("writes one verifiable anchor per fresh head, at the (org, seq) key", async () => {
    const k = await key();
    const h = head(5);
    const r2 = fakeR2();
    const res = await runAnchorCron({ ...(await deps([h], r2)), key: k });

    expect(res).toEqual({ orgsSeen: 1, anchorsWritten: 1, skipped: 0, failed: 0 });
    const objectKey = anchorR2Key(h.orgId, 5);
    expect(r2.store.has(objectKey)).toBe(true);
    expect(await verifyAnchor(k, r2.store.get(objectKey)!)).toBe(true);
  });

  it("is idempotent: an already-anchored head is skipped, not re-written", async () => {
    const h = head(7);
    const objectKey = anchorR2Key(h.orgId, 7);
    const r2 = fakeR2([objectKey]);
    const before = r2.store.get(objectKey);
    const res = await runAnchorCron(await deps([h], r2));

    expect(res).toMatchObject({ anchorsWritten: 0, skipped: 1, failed: 0 });
    expect(r2.store.get(objectKey)).toBe(before); // untouched
  });

  it("writes the new orgs and skips the already-anchored ones in one run", async () => {
    const fresh = head(1);
    const done = head(2);
    const r2 = fakeR2([anchorR2Key(done.orgId, 2)]);
    const res = await runAnchorCron(await deps([fresh, done], r2));

    expect(res).toMatchObject({ orgsSeen: 2, anchorsWritten: 1, skipped: 1, failed: 0 });
    expect(r2.store.has(anchorR2Key(fresh.orgId, 1))).toBe(true);
  });

  it("continues past a failing org and counts the failure (one blip isn't fatal)", async () => {
    const bad = head(3);
    const good = head(4);
    const logged: Record<string, unknown>[] = [];
    const res = await runAnchorCron(
      await deps([bad, good], fakeR2(), {
        putAnchorIfAbsent: async (objectKey: string, body: string) => {
          if (objectKey.includes(bad.orgId)) throw new Error("r2 unavailable");
          expect(body.length).toBeGreaterThan(0);
          return true;
        },
        log: (_m, f) => logged.push(f),
      }),
    );

    expect(res).toMatchObject({ orgsSeen: 2, anchorsWritten: 1, failed: 1 });
    expect(logged.some((f) => f.orgId === bad.orgId)).toBe(true);
  });

  it("reports zero work when no org has a chain", async () => {
    const res = await runAnchorCron(await deps([], fakeR2()));
    expect(res).toEqual({ orgsSeen: 0, anchorsWritten: 0, skipped: 0, failed: 0 });
  });
});
