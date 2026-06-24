import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { acquireListenLock, listenLockPath, ListenLockedError } from "./listen-lock.js";

const PROFILE = "default";
const EP = "11111111-1111-4111-8111-111111111111";
const mkStateDir = (): Promise<string> => mkdtemp(join(tmpdir(), "wbhk-lock-test-"));
const opts = (over: Partial<Parameters<typeof acquireListenLock>[3]> = {}) => ({
  pid: 4242,
  isAlive: () => true,
  now: () => 1,
  ...over,
});

describe("acquireListenLock", () => {
  it("acquires when free; release frees it so a later acquire succeeds", async () => {
    const dir = await mkStateDir();
    const lock = await acquireListenLock(dir, PROFILE, EP, opts());
    await lock.release();
    const again = await acquireListenLock(dir, PROFILE, EP, opts()); // free again
    await again.release();
  });

  it("refuses a second acquire while an ALIVE holder owns the lock", async () => {
    const dir = await mkStateDir();
    const held = await acquireListenLock(dir, PROFILE, EP, opts({ pid: 100, isAlive: () => true }));
    await expect(
      acquireListenLock(dir, PROFILE, EP, opts({ pid: 200, isAlive: () => true })),
    ).rejects.toBeInstanceOf(ListenLockedError);
    await held.release();
  });

  it("reclaims a STALE lock whose holder process is gone", async () => {
    const dir = await mkStateDir();
    await acquireListenLock(dir, PROFILE, EP, opts({ pid: 100 })); // left behind (not released)
    // a new run sees the leftover; holder 100 is dead → reclaim + acquire
    const lock = await acquireListenLock(
      dir,
      PROFILE,
      EP,
      opts({ pid: 200, isAlive: (p) => p !== 100 }),
    );
    await lock.release();
  });

  it("reclaims a corrupt/unreadable lock file", async () => {
    const dir = await mkStateDir();
    const path = listenLockPath(dir, PROFILE, EP);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not json at all");
    const lock = await acquireListenLock(dir, PROFILE, EP, opts()); // corrupt → reclaim
    await lock.release();
  });

  it("release is idempotent", async () => {
    const dir = await mkStateDir();
    const lock = await acquireListenLock(dir, PROFILE, EP, opts());
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("ListenLockedError exits LISTENER_BUSY and names the holder pid", async () => {
    const dir = await mkStateDir();
    const held = await acquireListenLock(dir, PROFILE, EP, opts({ pid: 777 }));
    const err = await acquireListenLock(dir, PROFILE, EP, opts({ pid: 888 })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ListenLockedError);
    expect((err as ListenLockedError).exitCode).toBe(18); // EXIT.LISTENER_BUSY
    expect((err as ListenLockedError).userMessage).toContain("777");
    await held.release();
  });
});
