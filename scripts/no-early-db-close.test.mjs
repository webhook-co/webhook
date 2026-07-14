import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A guard whose tests cannot make it fail is a decoration. These drive the REAL script over REAL files and
// assert it goes red on the exact regression it exists to prevent — a loader closing the shared tenant client.

const SCRIPT = new URL("./no-early-db-close.mjs", import.meta.url).pathname;

/** Run the guard against a throwaway repo whose apps/web/src/server contains `files`. */
function runGuard(files) {
  const root = mkdtempSync(join(tmpdir(), "db-close-guard-"));
  const serverDir = join(root, "apps/web/src/server");
  mkdirSync(serverDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(serverDir, name), body);
  // The script resolves its target relative to its own location, so run a copy from inside the fake root.
  mkdirSync(join(root, "scripts"), { recursive: true });
  const copied = join(root, "scripts/no-early-db-close.mjs");
  copyFileSync(SCRIPT, copied);
  try {
    const stdout = execFileSync("node", [copied], { encoding: "utf8" });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("passes when only db.ts closes the client", () => {
  const result = runGuard({
    "db.ts": "after(async () => { await app.end({ timeout: 5 }).catch(() => {}); });",
    "endpoints.ts": "export const load = async () => readEndpoints(await getTenantDb());",
  });
  assert.equal(result.ok, true, result.output);
});

// THE regression. `await app.end()` in a loader was not merely allowed before this change — it was REQUIRED,
// and it is still exactly what a reasonable contributor writes from memory. Now it tears the shared connection
// out from under every other loader in the same render.
test("fails when a loader closes the shared client", () => {
  const result = runGuard({
    "db.ts": "after(async () => { await app.end({ timeout: 5 }).catch(() => {}); });",
    "credentials.ts": `
      export async function loadCredentials(orgId) {
        const app = await getTenantDb();
        try {
          return await read(orgId, app);
        } finally {
          await app.end({ timeout: 5 }).catch(() => {});
        }
      }`,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /credentials\.ts/);
  assert.match(result.output, /closing the tenant Postgres client/);
});

test("fails when a deps factory re-adds its close hook", () => {
  const result = runGuard({
    "db.ts": "after(async () => { await app.end({ timeout: 5 }).catch(() => {}); });",
    "endpoint-mutations.ts": `
      const deps = {
        close: async () => {
          await app.end({ timeout: 5 }).catch(() => {});
        },
      };`,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /endpoint-mutations\.ts/);
});

// Tests legitimately assert ON closing — several of them exist precisely to prove the client is NOT closed
// during a request, and they mock a client and count `end` calls. Forbidding them from naming it would make
// the invariant untestable.
test("ignores test files, which must be able to assert about closing", () => {
  const result = runGuard({
    "db.ts": "after(async () => { await app.end({ timeout: 5 }).catch(() => {}); });",
    "db.test.ts": "expect(end).not.toHaveBeenCalled(); await app.end({ timeout: 5 });",
  });
  assert.equal(result.ok, true, result.output);
});

test("allows a close that argues for itself in the diff", () => {
  const result = runGuard({
    "db.ts": "after(async () => { await app.end({ timeout: 5 }).catch(() => {}); });",
    "special.ts":
      "await app.end({ timeout: 5 }); // db-close-allow: owns a pool nobody else can see",
  });
  assert.equal(result.ok, true, result.output);
});

// The receiver check must not fire on unrelated `.end(` — a false positive here would be a guard nobody keeps.
test("does not flag an unrelated .end( call", () => {
  const result = runGuard({
    "db.ts": "after(async () => { await app.end({ timeout: 5 }).catch(() => {}); });",
    "range.ts": "const last = window.end(cursor); const s = selection.end();",
  });
  assert.equal(result.ok, true, result.output);
});
