import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  UNSUBSTITUTED,
  findMissingLocalOverrides,
  placeholderVarsIn,
  placeholderVarsByApp,
} from "./dev-flag-parity-guard.mjs";

// A guard's tests must RUN the guard, not restate its list.

test("the real repo is clean — every placeholder var has a local override", () => {
  assert.deepEqual(findMissingLocalOverrides(), []);
});

test("discovery finds the real configs, and the floor is real", () => {
  const byApp = placeholderVarsByApp();
  // api/engine/web/mcp all carry behaviour flags as deploy-time placeholders.
  assert.ok(byApp.engine?.includes("FREE_EVENT_CAP"), JSON.stringify(byApp.engine));
  assert.ok(byApp.web?.includes("ASYNC_ORG_DELETION"), JSON.stringify(byApp.web));
  assert.ok(byApp.api?.includes("BILLING_MODE"), JSON.stringify(byApp.api));
});

test("matches a placeholder value", () => {
  assert.ok(UNSUBSTITUTED.test("<FREE_EVENT_CAP>"));
  assert.ok(UNSUBSTITUTED.test("<BILLING_MODE>"));
});

test("does NOT match a real value — the guard must not flag everything", () => {
  assert.ok(!UNSUBSTITUTED.test("5000"));
  assert.ok(!UNSUBSTITUTED.test("https://wbhk.my"));
  assert.ok(!UNSUBSTITUTED.test("test"));
  // Angle brackets alone are not a placeholder; the whole value must be one.
  assert.ok(!UNSUBSTITUTED.test("a <b> c"));
});

test("reads vars from a parsed config, NOT a text scan", () => {
  // A text scan would also catch the id fields below, which are infrastructure, not behaviour: locally
  // Miniflare uses its own resources and the id is never read. Flagging them would be noise that trains
  // people to ignore the guard.
  const text = `{
    // a comment, because these are .jsonc
    "vars": { "FREE_EVENT_CAP": "<FREE_EVENT_CAP>", "INGEST_BASE_URL": "https://wbhk.my" },
    "kv_namespaces": [{ "binding": "KV_CONFIG", "id": "<KV_CONFIG_ID>" }],
  }`;
  assert.deepEqual(placeholderVarsIn(text), ["FREE_EVENT_CAP"]);
});

test("a config with no vars block yields nothing rather than throwing", () => {
  assert.deepEqual(placeholderVarsIn('{ "name": "x" }'), []);
});

test("fails LOUD on a malformed config rather than reporting an empty set", () => {
  // A partial parse that silently returns [] is how a guard quietly stops checking.
  assert.throws(() => placeholderVarsIn("{ this is not json"), /parse/i);
});

test("reports an app whose placeholder var has no local override", () => {
  const dir = mkdtempSync(join(tmpdir(), "flagparity-"));
  try {
    mkdirSync(join(dir, "apps", "widget"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "widget", "wrangler.jsonc"),
      '{ "vars": { "NEW_FLAG": "<NEW_FLAG>" } }\n',
    );
    // A manifest that knows nothing about `widget`.
    const missing = findMissingLocalOverrides(dir, { widget: [] });
    assert.deepEqual(missing, [{ app: "widget", name: "NEW_FLAG" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an app WITH the override is not reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "flagparity-"));
  try {
    mkdirSync(join(dir, "apps", "widget"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "widget", "wrangler.jsonc"),
      '{ "vars": { "NEW_FLAG": "<NEW_FLAG>" } }\n',
    );
    assert.deepEqual(findMissingLocalOverrides(dir, { widget: ["NEW_FLAG"] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generated .prod. overlay is excluded — it is gitignored output", () => {
  const dir = mkdtempSync(join(tmpdir(), "flagparity-"));
  try {
    mkdirSync(join(dir, "apps", "widget"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "widget", "wrangler.prod.jsonc"),
      '{ "vars": { "NEW_FLAG": "<NEW_FLAG>" } }\n',
    );
    assert.deepEqual(findMissingLocalOverrides(dir, { widget: [] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
