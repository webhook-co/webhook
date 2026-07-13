import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isStillRelevant, readAdvisory, writeAdvisory } from "./advisory-store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wbhk-advisory-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const advisory = { deprecated: false, current: "0.2.0", latest: "0.3.0" };

describe("advisory store", () => {
  it("round-trips an advisory", async () => {
    await writeAdvisory(dir, advisory);
    expect(await readAdvisory(dir)).toEqual(advisory);
  });

  it("reads as 'none' when absent", async () => {
    expect(await readAdvisory(dir)).toBeNull();
  });

  // A cache that can brick the CLI would be far worse than a missed nudge.
  it("reads as 'none' on corrupt or half-written JSON instead of crashing", async () => {
    for (const junk of [
      "",
      "{",
      "null",
      '{"version":1}',
      '{"version":1,"advisory":{"latest":5}}',
    ]) {
      await writeFile(join(dir, "advisory.json"), junk);
      expect(await readAdvisory(dir)).toBeNull();
    }
  });

  it("never throws when the state dir cannot be written", async () => {
    await expect(writeAdvisory("/proc/nonexistent/nope", advisory)).resolves.toBeUndefined();
  });
});

describe("isStillRelevant", () => {
  it("is relevant while we are still on the version the server advised", () => {
    expect(isStillRelevant(advisory, "0.2.0")).toBe(true);
  });

  // The classic stale-notifier bug: keep nagging someone who already upgraded, and they learn to ignore it.
  it("is NOT relevant once the running version has moved on (post-upgrade)", () => {
    expect(isStillRelevant(advisory, "0.3.0")).toBe(false);
    expect(isStillRelevant(advisory, "0.2.1")).toBe(false);
  });
});
