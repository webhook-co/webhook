import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { discoverSubstitutes, LEDGER, undocumented, workerBypassed } from "./dev-parity-guard.mjs";

// docs/local-parity.md ends with "if you add a local substitute, add it here" — a rule enforced by
// nothing, which is why the page had already drifted: it still described web's bindings as opt-in two PRs
// after they became the default, and BILLING_MODE was never written down at all. This guard turns the
// convention into a check, and DISCOVERS the substitutes rather than restating them, so a new one is
// covered the moment it exists.

test("discovery finds every mode flag in the manifest", () => {
  const ids = discoverSubstitutes().map((s) => s.id);
  for (const flag of ["OAUTH_MODE", "EMAIL_MODE", "KMS_MODE", "BILLING_MODE"]) {
    assert.ok(ids.includes(flag), `${flag} is a local-only substitute but discovery missed it`);
  }
});

// The first version of this guard read ONLY the secrets manifest, and so reported "all substitutes are
// recorded" while missing TURNSTILE_MODE entirely — a flag that lives in apps/play/wrangler.jsonc, is
// "off" locally and "on" in production, and was nowhere on the page. A guard is only as honest as its
// narrowest input: scope the discovery and it cannot fail.
test("discovery reads mode flags out of wrangler vars, not just the manifest", () => {
  const ids = discoverSubstitutes().map((s) => s.id);
  assert.ok(
    ids.includes("TURNSTILE_MODE"),
    "a *_MODE flag declared in a wrangler config was missed",
  );
  assert.ok(
    ids.includes("BILLING_MODE"),
    "BILLING_MODE is declared in both places and must survive dedup",
  );
});

test("a mode flag declared in BOTH places is reported once", () => {
  const ids = discoverSubstitutes().map((s) => s.id);
  assert.equal(ids.filter((i) => i === "BILLING_MODE").length, 1);
});

test("discovery is not a hand-kept list", () => {
  // Feed it a manifest containing a flag that does not exist in this repo. A list would ignore it.
  const found = discoverSubstitutes({
    specsFor: () => [{ name: "TELEPORT_MODE", scope: "external" }],
    appNames: ["x"],
    apps: {},
  });
  assert.ok(
    found.some((s) => s.id === "TELEPORT_MODE"),
    "discovery restated a fixed list instead of reading the manifest",
  );
});

test("a Next app whose committed worker never runs locally is a substitute", () => {
  // www's wrangler main is a custom worker, but `next dev` does not run it — so the routes it adds are
  // absent locally. That is a real deviation and has to be on the page.
  assert.equal(workerBypassed("next dev -p 3002", "./worker/index.ts"), true);
  // web now runs the OpenNext preview, which DOES run its worker.
  assert.equal(
    workerBypassed("opennextjs-cloudflare preview -- -c x", ".open-next/worker.js"),
    false,
  );
  // a worker app is never bypassed — wrangler runs main by definition.
  assert.equal(workerBypassed("wrangler dev --port 8787", "src/index.ts"), false);
});

test("undocumented() reports exactly the tokens missing from the page", () => {
  const subs = [
    { id: "A_MODE", token: "A_MODE", why: "x" },
    { id: "B_MODE", token: "B_MODE", why: "y" },
  ];
  assert.deepEqual(undocumented(subs, "the page mentions A_MODE only"), ["B_MODE"]);
  assert.deepEqual(undocumented(subs, "A_MODE and B_MODE"), []);
});

// The load-bearing assertion: the REAL page must document every REAL substitute.
test("every discovered substitute is documented in docs/local-parity.md", () => {
  const doc = readFileSync(new URL(`../${LEDGER}`, import.meta.url), "utf8");
  const missing = undocumented(discoverSubstitutes(), doc);
  assert.deepEqual(
    missing,
    [],
    `undocumented local substitutes: ${missing.join(", ")} — add them to ${LEDGER}`,
  );
});

test("the check cannot pass by finding nothing", () => {
  // Anti-vacuity. If discovery broke and returned [], `undocumented` would be [] and the test above would
  // pass while checking nothing at all.
  assert.ok(
    discoverSubstitutes().length >= 5,
    `only ${discoverSubstitutes().length} substitutes discovered — discovery is probably broken`,
  );
});

test("every substitute explains itself", () => {
  for (const s of discoverSubstitutes()) {
    assert.ok(s.why && s.why.length > 15, `${s.id} has no reason attached`);
    assert.ok(s.token, `${s.id} has no token to look for in the page`);
  }
});

// A guard's tests must RUN the guard. Asserting on its exported helpers proves the logic; only executing
// it proves the thing `pnpm lint` actually invokes works — wrong path, bad import, or a crash in main()
// would all leave the helper tests perfectly green.
test("the guard executable itself passes on the committed tree", () => {
  const res = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./dev-parity-guard.mjs", import.meta.url))],
    {
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, `guard failed:\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /all \d+ local substitutes are recorded/);
});
