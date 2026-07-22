import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  check,
  discoverApps,
  hasReadyzRoute,
  EXEMPT,
  REQUIRES_READYZ,
} from "./readyz-coverage-guard.mjs";

/** Build a throwaway apps/ tree so the guard's logic is tested against inputs we control. */
function fixture(apps) {
  const root = mkdtempSync(join(tmpdir(), "readyz-guard-"));
  for (const [name, spec] of Object.entries(apps)) {
    const dir = join(root, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    if (spec.readyz === "literal") {
      writeFileSync(join(dir, "src", "index.ts"), 'if (url.pathname === "/readyz") { ok(); }');
    } else if (spec.readyz === "next-route") {
      mkdirSync(join(dir, "src", "app", "readyz"), { recursive: true });
      writeFileSync(
        join(dir, "src", "app", "readyz", "route.ts"),
        "export async function GET() {}",
      );
    } else {
      writeFileSync(join(dir, "src", "index.ts"), "export default {};");
    }
  }
  return root;
}

const nine = (over = {}) => {
  const base = {};
  for (const n of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) base[n] = {};
  return fixture({ ...base, ...over });
};

describe("readyz coverage guard", () => {
  it("passes on the real repository", () => {
    expect(check()).toEqual([]);
  });

  it("keeps REQUIRES_READYZ and EXEMPT disjoint and exhaustive over the real apps", () => {
    const apps = discoverApps();
    const classified = new Set([...REQUIRES_READYZ, ...Object.keys(EXEMPT)]);
    expect(apps.filter((a) => !classified.has(a))).toEqual([]);
  });

  // The floor is the difference between "everything is monitored" and "nothing was looked at".
  it("fails loudly when app discovery finds implausibly few apps", () => {
    const root = fixture({ only: {} });
    const problems = check({ appsDir: root, requires: [], exempt: {} });
    expect(problems.join(" ")).toMatch(/discovery floor/);
  });

  it("flags a new app that is neither required nor exempt", () => {
    const root = nine();
    const problems = check({ appsDir: root, requires: [], exempt: {} });
    expect(problems.some((p) => p.includes("apps/a is neither required"))).toBe(true);
  });

  it("flags a required app that has no /readyz route", () => {
    const root = nine({ api: { readyz: "none" } });
    const problems = check({
      appsDir: root,
      requires: ["api"],
      exempt: Object.fromEntries(
        ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n) => [n, "a sufficiently long reason"]),
      ),
    });
    expect(problems.some((p) => p.includes("exposes no /readyz route"))).toBe(true);
  });

  it("accepts a required app that has one", () => {
    const root = nine({ api: { readyz: "literal" } });
    const problems = check({
      appsDir: root,
      requires: ["api"],
      exempt: Object.fromEntries(
        ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n) => [n, "a sufficiently long reason"]),
      ),
    });
    expect(problems).toEqual([]);
  });

  // An exemption is where scrutiny goes to die, so a blank one must not pass.
  it("rejects an exemption with no substantive reason", () => {
    const root = nine();
    const exempt = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n) => [n, "a sufficiently long reason"]),
    );
    exempt.a = "todo";
    const problems = check({ appsDir: root, requires: [], exempt });
    expect(problems.some((p) => p.includes("exempt without a substantive reason"))).toBe(true);
  });

  it("rejects an app that is both required and exempt", () => {
    const root = nine({ api: { readyz: "literal" } });
    const exempt = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n) => [n, "a sufficiently long reason"]),
    );
    exempt.api = "a sufficiently long reason";
    const problems = check({ appsDir: root, requires: ["api"], exempt });
    expect(problems.some((p) => p.includes("both required and exempt"))).toBe(true);
  });

  it("recognises a Next.js app/readyz/route.ts, which carries no route literal", () => {
    const root = fixture({ web: { readyz: "next-route" } });
    expect(hasReadyzRoute(join(root, "web"))).toBe(true);
  });

  it("does not count a /readyz mention that only appears in a test file", () => {
    const root = mkdtempSync(join(tmpdir(), "readyz-guard-"));
    mkdirSync(join(root, "x", "src"), { recursive: true });
    writeFileSync(join(root, "x", "package.json"), "{}");
    writeFileSync(join(root, "x", "src", "thing.test.ts"), 'expect("/readyz").toBe("/readyz");');
    expect(hasReadyzRoute(join(root, "x"))).toBe(false);
  });
});
