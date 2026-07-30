import assert from "node:assert/strict";
import { test } from "node:test";

import { NEXT_CONFIGS, appsMissingDevOrigin, readConfigSource } from "./dev-origins-guard.mjs";

// The bug this pins: `127.0.0.1:<port>` and `localhost:<port>` are the same server but DIFFERENT origins
// to Next, which refuses dev-asset requests from an origin it wasn't started on. Nothing errors loudly —
// the HTML, the CSP and the status code all look perfect to curl — but the client bundle is refused, so
// React never hydrates. On /login that surfaced as a captcha stuck on "Verifying you're human…", which
// reads as a broken widget rather than a host mismatch. The rest of the dev stack pins 127.0.0.1
// (`wrangler dev --ip 127.0.0.1`), so it is the natural host to reach for.

test("every Next app is discovered, not hand-listed", () => {
  // A hand-maintained list silently stops covering the app added after it was written.
  assert.ok(NEXT_CONFIGS.length >= 3, `expected ≥3 Next apps, found ${NEXT_CONFIGS.length}`);
  const apps = NEXT_CONFIGS.map((c) => c.app).sort();
  for (const expected of ["auth", "web", "www"]) {
    assert.ok(apps.includes(expected), `${expected} missing from discovered Next apps: ${apps}`);
  }
});

test("every discovered config is readable and non-empty", () => {
  // Guards against the whole suite passing vacuously on a wrong path (ENOENT would throw; empty would not).
  for (const { app, path } of NEXT_CONFIGS) {
    const src = readConfigSource(path);
    assert.ok(src.length > 0, `${app}: next.config.ts read as empty`);
  }
});

test("no Next app is missing the 127.0.0.1 dev origin", () => {
  assert.deepEqual(appsMissingDevOrigin(), []);
});

test("the check actually fails when the allowance is absent (anti-vacuity)", () => {
  // Mutation check: if this returned [] for a config that plainly lacks the key, the guard above would
  // pass forever no matter what the real configs said.
  const missing = appsMissingDevOrigin([
    { app: "fake", path: "<memory>", source: "const c = { reactStrictMode: true };" },
  ]);
  assert.deepEqual(
    missing.map((m) => m.app),
    ["fake"],
  );
});

test("a commented-out allowance does not count as present", () => {
  // A guard that text-scans without stripping comments can be satisfied by a note ABOUT the knob.
  const missing = appsMissingDevOrigin([
    {
      app: "fake",
      path: "<memory>",
      source: '// allowedDevOrigins: ["127.0.0.1"] would go here\n',
    },
  ]);
  assert.deepEqual(
    missing.map((m) => m.app),
    ["fake"],
  );
});

test("the allowance must name 127.0.0.1 specifically, not just the key", () => {
  const missing = appsMissingDevOrigin([
    { app: "fake", path: "<memory>", source: 'allowedDevOrigins: ["example.test"],' },
  ]);
  assert.deepEqual(
    missing.map((m) => m.app),
    ["fake"],
  );
});
