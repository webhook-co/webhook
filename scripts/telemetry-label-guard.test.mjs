import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readCatalog, validateCatalog } from "./telemetry-label-guard.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REAL_CATALOG = join(SCRIPTS, "..", "packages", "shared", "src", "telemetry-catalog.json");

// The invariant, proven against the REAL committed catalog — this is the guard running against production.
test("the committed telemetry catalog validates clean", () => {
  assert.deepEqual(validateCatalog(readCatalog(REAL_CATALOG)), []);
});

// Zero-input floor: an empty/absent catalog must FAIL, never read as "passed" (the no-unverified-claims lesson).
test("an empty catalog is a violation (zero-input floor)", () => {
  assert.notEqual(validateCatalog({}).length, 0);
  assert.notEqual(validateCatalog({ labelAllowlist: [], metrics: {} }).length, 0);
  assert.notEqual(validateCatalog(null).length, 0);
});

test("readCatalog throws on a missing file (floor — a missing catalog cannot silently pass)", () => {
  assert.throws(() => readCatalog(join(SCRIPTS, "does-not-exist.json")));
});

test("a metric declaring an id-shaped label key is a violation", () => {
  const poisoned = {
    labelAllowlist: ["outcome", "org_id"],
    metrics: { "ingest.requests": { kind: "counter", help: "x", labels: ["org_id"] } },
  };
  const violations = validateCatalog(poisoned);
  assert.ok(
    violations.some((v) => /org_id/.test(v)),
    `expected an id-shaped-label violation, got: ${JSON.stringify(violations)}`,
  );
});

test("an ip / path / host label key is caught by the extended id-shape denylist", () => {
  for (const idKey of ["client_ip", "request_path", "host", "session_id"]) {
    const poisoned = {
      labelAllowlist: ["outcome", idKey],
      metrics: { "ingest.requests": { kind: "counter", help: "x", labels: [idKey] } },
    };
    const violations = validateCatalog(poisoned);
    assert.ok(
      violations.some((v) => v.includes(idKey)),
      `expected an id-shaped-label violation for "${idKey}", got: ${JSON.stringify(violations)}`,
    );
  }
});

test("a metric with a missing/non-array labels is a violation (fail closed, no throw)", () => {
  const noLabels = {
    labelAllowlist: ["outcome"],
    metrics: { "ingest.requests": { kind: "counter", help: "x" } },
  };
  const violations = validateCatalog(noLabels);
  assert.ok(
    violations.some((v) => /no labels array/.test(v)),
    `expected a no-labels-array violation, got: ${JSON.stringify(violations)}`,
  );
});

test("a metric label outside the allowlist is a violation", () => {
  const offAllowlist = {
    labelAllowlist: ["outcome"],
    metrics: { "ingest.requests": { kind: "counter", help: "x", labels: ["method"] } },
  };
  const violations = validateCatalog(offAllowlist);
  assert.ok(
    violations.some((v) => /method/.test(v)),
    `expected an off-allowlist violation, got: ${JSON.stringify(violations)}`,
  );
});
