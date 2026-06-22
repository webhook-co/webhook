import { mkdtemp, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { clearCursor, cursorFilePath, loadCursor, saveCursor } from "./cursor-store.js";

const EP = "11111111-1111-4111-8111-111111111111";

async function freshState(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wbhk-cursor-test-"));
}

describe("cursorFilePath", () => {
  it("stays under <stateDir>/listen and is traversal-safe for a hostile profile name", () => {
    const path = cursorFilePath("/state", "../../etc", EP);
    // The separator in a hostile name is percent-encoded, so the file sits DIRECTLY under listen/ —
    // it can't escape into a parent dir (the literal `..` chars in one filename segment are harmless).
    expect(dirname(path)).toBe(join("/state", "listen"));
  });
});

describe("cursor-store round-trip", () => {
  it("saves then loads the cursor for a (profile, endpoint)", async () => {
    const dir = await freshState();
    await saveCursor(dir, "default", EP, "cur_abc");
    await expect(loadCursor(dir, "default", EP)).resolves.toEqual({
      kind: "hit",
      cursor: "cur_abc",
    });
  });

  it("writes a 0600 file under a 0700 listen/ dir, leaving no temp file behind", async () => {
    const dir = await freshState();
    await saveCursor(dir, "default", EP, "cur_abc");
    const path = cursorFilePath(dir, "default", EP);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    // the atomic temp file is renamed away — only the final file remains
    const entries = await readdir(dirname(path));
    expect(entries.filter((e) => e.includes(".tmp"))).toHaveLength(0);
  });

  it("overwrites an existing cursor (last write wins)", async () => {
    const dir = await freshState();
    await saveCursor(dir, "default", EP, "cur_old");
    await saveCursor(dir, "default", EP, "cur_new");
    await expect(loadCursor(dir, "default", EP)).resolves.toEqual({
      kind: "hit",
      cursor: "cur_new",
    });
  });

  it("keeps separate cursors per profile and per endpoint", async () => {
    const dir = await freshState();
    const EP2 = "22222222-2222-4222-8222-222222222222";
    await saveCursor(dir, "default", EP, "cur_default_ep1");
    await saveCursor(dir, "staging", EP, "cur_staging_ep1");
    await saveCursor(dir, "default", EP2, "cur_default_ep2");
    await expect(loadCursor(dir, "default", EP)).resolves.toMatchObject({
      cursor: "cur_default_ep1",
    });
    await expect(loadCursor(dir, "staging", EP)).resolves.toMatchObject({
      cursor: "cur_staging_ep1",
    });
    await expect(loadCursor(dir, "default", EP2)).resolves.toMatchObject({
      cursor: "cur_default_ep2",
    });
  });
});

describe("cursor-store load edge cases (corruption → cold-start, never a crash)", () => {
  it("returns miss when no cursor is stored", async () => {
    const dir = await freshState();
    await expect(loadCursor(dir, "default", EP)).resolves.toEqual({ kind: "miss" });
  });

  it("returns corrupt on invalid JSON", async () => {
    const dir = await freshState();
    const path = cursorFilePath(dir, "default", EP);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "{ not json", { mode: 0o600 });
    const res = await loadCursor(dir, "default", EP);
    expect(res.kind).toBe("corrupt");
  });

  it("returns corrupt on a schema mismatch (wrong/old shape)", async () => {
    const dir = await freshState();
    const path = cursorFilePath(dir, "default", EP);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ version: 99, cursor: "x" }), { mode: 0o600 });
    expect((await loadCursor(dir, "default", EP)).kind).toBe("corrupt");
  });

  it("returns corrupt when the stored endpointId does not match (defense-in-depth)", async () => {
    const dir = await freshState();
    const path = cursorFilePath(dir, "default", EP);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ version: 1, endpointId: "other", cursor: "x" }), {
      mode: 0o600,
    });
    expect((await loadCursor(dir, "default", EP)).kind).toBe("corrupt");
  });
});

describe("clearCursor", () => {
  it("removes a stored cursor (next load is a miss)", async () => {
    const dir = await freshState();
    await saveCursor(dir, "default", EP, "cur_abc");
    await clearCursor(dir, "default", EP);
    await expect(loadCursor(dir, "default", EP)).resolves.toEqual({ kind: "miss" });
  });

  it("is a no-op when nothing is stored", async () => {
    const dir = await freshState();
    await expect(clearCursor(dir, "default", EP)).resolves.toBeUndefined();
  });
});
