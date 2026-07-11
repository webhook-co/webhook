import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkCronSync,
  cronSyncViolations,
  extractCronConst,
  readWranglerCrons,
} from "./cap-cron-sync-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_SRC = readFileSync(join(ROOT, "apps/engine/src/index.ts"), "utf8");
const WRANGLER_TEXT = readFileSync(join(ROOT, "apps/engine/wrangler.jsonc"), "utf8");

// The invariant, proven against the REAL committed config — this is the guard running against production.
test("the actual engine config is in sync (checkCronSync on the real files → no violations)", () => {
  assert.deepEqual(checkCronSync(INDEX_SRC, WRANGLER_TEXT), []);
});

test("extractCronConst reads both real constants; null for a missing/non-literal one", () => {
  assert.equal(extractCronConst(INDEX_SRC, "CAP_PRODUCER_CRON"), "*/5 * * * *");
  assert.equal(extractCronConst(INDEX_SRC, "HOURLY_CRON"), "0 * * * *");
  assert.equal(extractCronConst(INDEX_SRC, "NOT_A_CONST"), null);
  assert.equal(
    extractCronConst("export const CAP_PRODUCER_CRON = someVar;", "CAP_PRODUCER_CRON"),
    null,
  );
});

test("readWranglerCrons parses the real triggers, tolerates inline comments, fails closed on junk", () => {
  assert.deepEqual(readWranglerCrons(WRANGLER_TEXT), ["0 * * * *", "*/5 * * * *"]);
  // Multi-line with inline // comments + trailing comma (cron strings hold no `//`, so stripping is safe).
  const multiline = `{
    "triggers": {
      "crons": [
        "0 * * * *", // hourly heavy jobs
        "*/5 * * * *", // soft-cap fast path
      ],
    },
  }`;
  assert.deepEqual(readWranglerCrons(multiline), ["0 * * * *", "*/5 * * * *"]);
  assert.equal(readWranglerCrons("{}"), null); // no crons key
  assert.equal(readWranglerCrons('"crons": [oops]'), null); // unparseable
  assert.equal(readWranglerCrons(42), null); // non-string input
});

test("cronSyncViolations: an exactly-matching set (any order / whitespace) is clean", () => {
  assert.deepEqual(
    cronSyncViolations(["*/5 * * * *", "0 * * * *"], ["0 * * * *", "*/5 * * * *"]),
    [],
  );
  assert.deepEqual(
    cronSyncViolations(["*/5 * * * *", "0 * * * *"], ["  0  * * * * ", "*/5 * * * *"]),
    [],
  );
});

test("cronSyncViolations flags a cap trigger that's MISSING from wrangler (fast path silently lost)", () => {
  const v = cronSyncViolations(["*/5 * * * *", "0 * * * *"], ["0 * * * *"]);
  assert.equal(v.length, 1);
  assert.match(v[0], /\*\/5 \* \* \* \*/);
  assert.match(v[0], /never fires|lacks it/);
});

test("cronSyncViolations flags an EXTRA wrangler cron the code doesn't handle (heavy jobs on it)", () => {
  const v = cronSyncViolations(
    ["*/5 * * * *", "0 * * * *"],
    ["0 * * * *", "*/5 * * * *", "*/1 * * * *"],
  );
  assert.equal(v.length, 1);
  assert.match(v[0], /\*\/1 \* \* \* \*/);
  assert.match(v[0], /HEAVY|doesn't name it/);
});

test("cronSyncViolations FAILS CLOSED when either side is unreadable", () => {
  assert.deepEqual(cronSyncViolations([], ["0 * * * *"]).length, 1);
  assert.deepEqual(cronSyncViolations(["0 * * * *"], null).length, 1);
  assert.deepEqual(cronSyncViolations(["0 * * * *"], []).length, 1);
});

test("checkCronSync FAILS CLOSED when a constant is missing from the index source", () => {
  const v = checkCronSync('export const HOURLY_CRON = "0 * * * *";', WRANGLER_TEXT);
  assert.equal(v.length, 1);
  assert.match(v[0], /could not read/);
});

test("checkCronSync catches a real drift: index.ts renames the cap cron but wrangler is untouched", () => {
  const drifted = INDEX_SRC.replace(
    'export const CAP_PRODUCER_CRON = "*/5 * * * *"',
    'export const CAP_PRODUCER_CRON = "*/3 * * * *"',
  );
  assert.notEqual(drifted, INDEX_SRC); // the replace actually hit
  const v = checkCronSync(drifted, WRANGLER_TEXT);
  // */3 is expected by code but absent from wrangler; */5 is in wrangler but no longer named by code.
  assert.equal(v.length, 2);
});
