import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_URL, assertLocalTarget, resolveSeedUrl } from "./seed-target.mjs";

// `pnpm seed` writes fixed-UUID orgs, users, memberships and endpoints, signs their audit rows with a
// PUBLISHED dev key, and hashes their ingest tokens with a PUBLISHED dev pepper. Pointed at a real database
// that is a data-integrity incident: those tenants' tamper-evident audit chains would be signed by a key
// anyone can read out of this repo.
//
// `DATABASE_URL` is the same variable scripts/apply-prod-migrations.sh expects to hold the PROD owner
// connection — so "I still had it exported from the migration" is the ordinary way this happens, not an
// exotic one. Hence: fail closed on any host that is not this machine.

test("accepts the loopback IP", () => {
  assertLocalTarget("postgres://postgres@127.0.0.1:5432/webhook_dev");
});

test("accepts localhost", () => {
  assertLocalTarget("postgres://postgres@localhost:5432/webhook_dev");
});

test("accepts the IPv6 loopback", () => {
  assertLocalTarget("postgres://postgres@[::1]:5432/webhook_dev");
});

test("REFUSES a Neon host", () => {
  assert.throws(
    () => assertLocalTarget("postgres://owner:pw@ep-cool-name.us-east-2.aws.neon.tech/webhook"),
    /refusing to seed/,
  );
});

test("the refusal names the host it refused, so the mistake is obvious", () => {
  // A predicate, not a regex. An unanchored host-shaped pattern is what CodeQL's
  // js/regex/missing-regexp-anchor flags (HIGH), and rightly in general — it just happens to be an
  // assertion on an error message here rather than a check on a URL. `includes` says what is meant
  // exactly, so the rule has nothing to warn about and the assertion is more precise.
  assert.throws(
    () => assertLocalTarget("postgres://owner:pw@db.example.com/webhook"),
    (err) => err.message.includes("db.example.com"),
  );
});

test("the refusal NEVER echoes the connection string — it carries a password", () => {
  const url = "postgres://owner:hunter2-super-secret@db.example.com/webhook";
  try {
    assertLocalTarget(url);
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(!String(err.message).includes("hunter2-super-secret"), String(err.message));
  }
});

// A lookalike host is not local. `localhost.attacker.example` resolves wherever its owner points it.
test("REFUSES a host that merely contains localhost", () => {
  assert.throws(
    () => assertLocalTarget("postgres://u@localhost.attacker.example/db"),
    /refusing to seed/,
  );
});

test("REFUSES an unparseable target rather than assuming it is fine", () => {
  assert.throws(() => assertLocalTarget("not a url"), /refusing to seed/);
});

// DEV_DB is the variable scripts/dev-db.sh prints. DATABASE_URL is the one the PROD migration runbook
// uses. When both are set, the local-oriented one must win — belt and braces alongside the host check.
test("prefers DEV_DB over DATABASE_URL", () => {
  const url = resolveSeedUrl({
    DEV_DB: "postgres://postgres@127.0.0.1:5432/dev",
    DATABASE_URL: "postgres://owner@prod.example.com/prod",
  });
  assert.equal(url, "postgres://postgres@127.0.0.1:5432/dev");
});

test("falls back to DATABASE_URL when DEV_DB is unset", () => {
  assert.equal(
    resolveSeedUrl({ DATABASE_URL: "postgres://postgres@localhost:5432/x" }),
    "postgres://postgres@localhost:5432/x",
  );
});

test("falls back to the documented local default when neither is set", () => {
  assert.equal(resolveSeedUrl({}), DEFAULT_URL);
});

test("an empty variable is treated as unset, not as a target", () => {
  assert.equal(resolveSeedUrl({ DEV_DB: "", DATABASE_URL: "" }), DEFAULT_URL);
});
