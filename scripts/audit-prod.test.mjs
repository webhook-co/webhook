import assert from "node:assert/strict";
import { test } from "node:test";

import { blockingLevelFromArgv, classifyAdvisories, parseProdTree } from "./audit-prod.mjs";

// The pure decision logic of the production-dependency audit gate (scripts/audit-prod.mjs). The live
// pnpm-tree collection and the network fetch are the thin shell around these; the gate's correctness
// (which severities block, which deps are audited) lives here.

// ---- parseProdTree ----

test("parseProdTree: keeps semver versions, skips link:/workspace/non-semver", () => {
  const tree = [
    {
      dependencies: {
        "pkg-a": { version: "1.2.3" },
        "@scope/pkg-b": { version: "0.0.1" },
        "workspace-dep": { version: "link:../local" }, // skipped
        "file-dep": { version: "file:../thing" }, // skipped
      },
    },
  ];
  const map = parseProdTree(tree);
  assert.deepEqual([...map.get("pkg-a")], ["1.2.3"]);
  assert.deepEqual([...map.get("@scope/pkg-b")], ["0.0.1"]);
  assert.equal(map.has("workspace-dep"), false);
  assert.equal(map.has("file-dep"), false);
});

test("parseProdTree: walks transitive deps and merges duplicate versions into a set", () => {
  const tree = [
    {
      dependencies: {
        top: {
          version: "1.0.0",
          dependencies: {
            shared: { version: "2.0.0" },
          },
        },
        other: {
          version: "3.0.0",
          dependencies: {
            shared: { version: "2.0.0" }, // same version — deduped
            deep: { version: "4.0.0", dependencies: { deeper: { version: "5.0.0" } } },
          },
        },
      },
    },
  ];
  const map = parseProdTree(tree);
  assert.deepEqual([...map.get("shared")], ["2.0.0"]); // one entry, not two
  assert.deepEqual([...map.get("deeper")], ["5.0.0"]); // reached via nested .dependencies
});

test("parseProdTree: includes optionalDependencies, tolerates missing sections and multiple workspaces", () => {
  const tree = [
    { dependencies: { a: { version: "1.0.0" } } },
    { optionalDependencies: { b: { version: "2.0.0" } } },
    {}, // a workspace with neither section
  ];
  const map = parseProdTree(tree);
  assert.deepEqual([...map.get("a")], ["1.0.0"]);
  assert.deepEqual([...map.get("b")], ["2.0.0"]);
});

// ---- classifyAdvisories ----

const ADVISORIES = {
  "crit-pkg": [{ severity: "critical", title: "RCE", url: "https://x/1" }],
  "high-pkg": [{ severity: "high", title: "XSS", url: "https://x/2" }],
  "mod-pkg": [{ severity: "moderate", title: "ReDoS", url: "https://x/3" }],
  "low-pkg": [{ severity: "low", title: "info leak", url: "https://x/4" }],
};

test("classifyAdvisories at 'critical': only critical blocks; high is advisory; moderate/low neither", () => {
  const { blocking, advisoryOnly } = classifyAdvisories(ADVISORIES, "critical");
  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /crit-pkg/);
  assert.equal(advisoryOnly.length, 1);
  assert.match(advisoryOnly[0], /high-pkg/);
});

test("classifyAdvisories at 'high': critical AND high block; moderate/low still neither", () => {
  const { blocking, advisoryOnly } = classifyAdvisories(ADVISORIES, "high");
  assert.deepEqual(blocking.map((l) => l.split(" — ")[0]).sort(), ["crit-pkg", "high-pkg"]);
  assert.equal(advisoryOnly.length, 0); // nothing is "above high but below the block level" now
});

test("classifyAdvisories: multiple advisories on one package are classified independently", () => {
  const multi = {
    "mixed-pkg": [
      { severity: "critical", title: "A", url: "u" },
      { severity: "high", title: "B", url: "u" },
      { severity: "low", title: "C", url: "u" },
    ],
  };
  const { blocking, advisoryOnly } = classifyAdvisories(multi, "critical");
  assert.equal(blocking.length, 1); // the critical one
  assert.equal(advisoryOnly.length, 1); // the high one; the low one is dropped
});

test("classifyAdvisories: empty / undefined advisories → empty buckets (a clean tree passes)", () => {
  assert.deepEqual(classifyAdvisories({}, "critical"), { blocking: [], advisoryOnly: [] });
  assert.deepEqual(classifyAdvisories(undefined, "critical"), { blocking: [], advisoryOnly: [] });
});

// ---- blockingLevelFromArgv ----

test("blockingLevelFromArgv: defaults to critical; honors --level=high; unknown → critical", () => {
  assert.equal(blockingLevelFromArgv(["node", "audit-prod.mjs"]), "critical");
  assert.equal(blockingLevelFromArgv(["node", "audit-prod.mjs", "--level=high"]), "high");
  assert.equal(blockingLevelFromArgv(["node", "audit-prod.mjs", "--level=critical"]), "critical");
  assert.equal(blockingLevelFromArgv(["node", "audit-prod.mjs", "--level=bogus"]), "critical");
});
