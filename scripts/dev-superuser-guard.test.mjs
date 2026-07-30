import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_BINDINGS, SUPERUSER_ROLES, superuserBindings } from "./dev-superuser-guard.mjs";

// Why this guard exists: a Hyperdrive binding whose local connection string connects as `postgres`
// gets a SUPERUSER, and a superuser bypasses row-level security unconditionally. So a query that
// production would REFUSE succeeds locally — and, worse, succeeds in CI. Tenant-isolation bugs are
// exactly the class this repo's RLS policies exist to stop, and this is the one gap that lets one
// through every gate we have.
//
// Note the direction of the failure. A missing service binding fails LOUDLY at call time. A superuser
// binding fails SILENTLY, by permitting something it should not, so nothing ever draws attention to it.

test("bindings are DISCOVERED from the wrangler configs, not hand-listed", () => {
  // A hand-kept list stops covering the binding added after it was written — and the whole point of
  // scripts/dev-db-config.mjs is that the roles are derived from the configs.
  assert.ok(
    LOCAL_BINDINGS.length >= 20,
    `expected ≥20 local bindings, found ${LOCAL_BINDINGS.length}`,
  );
  const apps = new Set(LOCAL_BINDINGS.map((b) => b.app));
  for (const expected of ["api", "auth", "engine", "mcp", "web"]) {
    assert.ok(apps.has(expected), `${expected} has no local Hyperdrive binding — discovery broke`);
  }
});

test("every discovered binding names a role and a binding", () => {
  for (const b of LOCAL_BINDINGS) {
    assert.ok(b.binding.length > 0, `${b.app}: a binding with no name`);
    assert.ok(b.role.length > 0, `${b.app}/${b.binding}: no role in the connection string`);
  }
});

test("no local binding connects as a superuser", () => {
  assert.deepEqual(
    superuserBindings().map((b) => `${b.app}/${b.binding}`),
    [],
  );
});

// Anti-vacuity: if superuserBindings() returned [] unconditionally, the test above would pass forever
// no matter what the configs said.
test("the check actually fails on a superuser connection string", () => {
  const found = superuserBindings([
    { app: "fake", binding: "HYPERDRIVE_X", role: "postgres" },
    { app: "fake", binding: "HYPERDRIVE_Y", role: "webhook_app" },
  ]);
  assert.deepEqual(
    found.map((b) => b.binding),
    ["HYPERDRIVE_X"],
  );
});

test("every known superuser role is caught, not just `postgres`", () => {
  const rows = [...SUPERUSER_ROLES].map((role, i) => ({ app: "fake", binding: `B${i}`, role }));
  assert.equal(superuserBindings(rows).length, rows.length);
});
