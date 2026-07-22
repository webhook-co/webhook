import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REGISTERED_JOBS } from "./heartbeat";

/**
 * The registry and the call sites must not drift apart.
 *
 * A registered job with no caller is permanently red for a job that is fine. A caller reporting an
 * id the registry rejects is silently 404'd by the health Worker, so the job looks unobserved while
 * appearing wired. Both failures are invisible without this test.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APPS = join(REPO, "apps");

/** Every `withHeartbeat(env, "<id>", ...)` id actually present in the source tree. */
function callSiteIds(): Set<string> {
  const ids = new Set<string>();
  const stack = [APPS];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".turbo") {
          stack.push(full);
        }
        continue;
      }
      if (!/\.ts$/.test(entry.name) || entry.name.includes(".test.")) continue;
      for (const m of readFileSync(full, "utf8").matchAll(
        /withHeartbeat\(\s*env\s*,\s*"([a-z0-9-]+)"/g,
      )) {
        ids.add(m[1] as string);
      }
    }
  }
  return ids;
}

describe("heartbeat registry ↔ call sites", () => {
  it("finds the apps directory it is meant to scan", () => {
    // Floor: without this, a wrong path scans nothing and every assertion below passes vacuously.
    expect(statSync(APPS).isDirectory()).toBe(true);
    expect(callSiteIds().size).toBeGreaterThan(0);
  });

  it("has a caller for every registered job", () => {
    const callers = callSiteIds();
    const missing = REGISTERED_JOBS.map((j) => j.id).filter((id) => !callers.has(id));
    expect(missing).toEqual([]);
  });

  it("registers every id that a caller reports", () => {
    const registered = new Set(REGISTERED_JOBS.map((j) => j.id));
    const unregistered = [...callSiteIds()].filter((id) => !registered.has(id));
    expect(unregistered).toEqual([]);
  });
});
