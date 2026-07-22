import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
const nine = (over = {}) => fixture({ ...Object.fromEntries(NAMES.map((n) => [n, {}])), ...over });
const reasons = () => Object.fromEntries(NAMES.map((n) => [n, "a sufficiently long reason"]));

// The invariant, proven against the REAL repository — this is the guard running against production.
test("the actual repository passes the guard", () => {
  assert.deepEqual(check(), []);
});

test("REQUIRES_READYZ and EXEMPT together classify every real app", () => {
  const classified = new Set([...REQUIRES_READYZ, ...Object.keys(EXEMPT)]);
  assert.deepEqual(
    discoverApps().filter((a) => !classified.has(a)),
    [],
  );
});

// The floor is the difference between "everything is monitored" and "nothing was looked at".
test("fails loudly when app discovery finds implausibly few apps", () => {
  const problems = check({ appsDir: fixture({ only: {} }), requires: [], exempt: {} });
  assert.match(problems.join(" "), /discovery floor/);
});

test("flags a new app that is neither required nor exempt", () => {
  const problems = check({ appsDir: nine(), requires: [], exempt: {} });
  assert.ok(problems.some((p) => p.includes("apps/a is neither required")));
});

test("flags a required app that has no /readyz route", () => {
  const problems = check({
    appsDir: nine({ api: { readyz: "none" } }),
    requires: ["api"],
    exempt: reasons(),
  });
  assert.ok(problems.some((p) => p.includes("exposes no /readyz route")));
});

test("accepts a required app that has one", () => {
  const problems = check({
    appsDir: nine({ api: { readyz: "literal" } }),
    requires: ["api"],
    exempt: reasons(),
  });
  assert.deepEqual(problems, []);
});

// An exemption is where scrutiny goes to die, so a blank one must not pass.
test("rejects an exemption with no substantive reason", () => {
  const exempt = reasons();
  exempt.a = "todo";
  const problems = check({ appsDir: nine(), requires: [], exempt });
  assert.ok(problems.some((p) => p.includes("exempt without a substantive reason")));
});

test("rejects an app that is both required and exempt", () => {
  const exempt = reasons();
  exempt.api = "a sufficiently long reason";
  const problems = check({
    appsDir: nine({ api: { readyz: "literal" } }),
    requires: ["api"],
    exempt,
  });
  assert.ok(problems.some((p) => p.includes("both required and exempt")));
});

test("recognises a Next.js app/readyz/route.ts, which carries no route literal", () => {
  const root = fixture({ web: { readyz: "next-route" } });
  assert.equal(hasReadyzRoute(join(root, "web")), true);
});

test("does not count a /readyz mention that only appears in a test file", () => {
  const root = mkdtempSync(join(tmpdir(), "readyz-guard-"));
  mkdirSync(join(root, "x", "src"), { recursive: true });
  writeFileSync(join(root, "x", "package.json"), "{}");
  writeFileSync(join(root, "x", "src", "thing.test.ts"), 'expect("/readyz").toBe("/readyz");');
  assert.equal(hasReadyzRoute(join(root, "x")), false);
});
