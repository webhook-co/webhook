// Exercises the C1 rule (ADR-0002): app code must not read the CACHED Hyperdrive binding, because its query
// cache is keyed on SQL+params and is blind to the RLS org GUC — so a tenant read through it serves one org's
// rows to another.
//
// This file exists because nothing exercised those selectors, and that absence is exactly how the gap it now
// pins lived undetected: `const { HYPERDRIVE_CACHED } = env` is an ObjectPattern, NOT a MemberExpression, so
// it evaded the rule entirely while the rule's own comment claimed to catch "any indirection". A lint rule
// with no test is a claim, not a check.
//
// Runs the REAL flat config against real source strings via ESLint's Node API — no fixture files, no
// re-implementation of the selectors.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C1 = /C1 \(ADR-0002\)/;

/** Lint `code` as if it were this file inside apps/web, and return its messages. */
async function lint(code) {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, {
    filePath: join(ROOT, "apps/web/src/__c1_probe.ts"),
  });
  return result.messages;
}

const flagged = async (code) => (await lint(code)).some((m) => C1.test(m.message));

test("member access is flagged", async () => {
  assert.ok(
    await flagged(`export const f = (env: any) => env.HYPERDRIVE_CACHED.connectionString;`),
  );
});

test("computed-literal access is flagged", async () => {
  assert.ok(
    await flagged(`export const f = (env: any) => env["HYPERDRIVE_CACHED"].connectionString;`),
  );
});

// THE GAP THIS FILE EXISTS FOR: these three passed the rule cleanly before the ObjectPattern selectors.
test("plain destructuring is flagged", async () => {
  assert.ok(
    await flagged(
      `export const f = (env: any) => { const { HYPERDRIVE_CACHED } = env; return HYPERDRIVE_CACHED; };`,
    ),
  );
});

test("renamed destructuring is flagged", async () => {
  assert.ok(
    await flagged(
      `export const f = (env: any) => { const { HYPERDRIVE_CACHED: x } = env; return x; };`,
    ),
  );
});

test("string-keyed destructuring is flagged", async () => {
  assert.ok(
    await flagged(
      `export const f = (env: any) => { const { "HYPERDRIVE_CACHED": y } = env; return y; };`,
    ),
  );
});

test("reading the TENANT binding is NOT flagged (the rule is not a blanket ban)", async () => {
  assert.equal(
    await flagged(`export const f = (env: any) => env.HYPERDRIVE_TENANT.connectionString;`),
    false,
  );
});

// Pins the rule's ACKNOWLEDGED limit rather than pretending it doesn't exist: a syntactic selector cannot
// resolve a variable key. This comment used to add "the deploy-time posture check is what covers this case" —
// false, and a reviewer trusting it would have approved a real leak: that check reads wrangler configs, not
// source. What actually makes this safe is that there is no caching BINDING left to resolve to (the dead
// HYPERDRIVE_CACHED one was deleted). Re-add a caching binding and this gap is real again.
test("a VARIABLE-keyed access is NOT flagged — the documented limit, not an oversight", async () => {
  assert.equal(
    await flagged(`export const f = (env: any, k: string) => env[k].connectionString;`),
    false,
  );
});
