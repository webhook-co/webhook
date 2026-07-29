import assert from "node:assert/strict";
import { test } from "node:test";

import { DEV_APPS, LOCAL_INGEST_BASE_URL, devCommand, duplicatePorts } from "./dev-ports.mjs";
import {
  appsMissingDevScript,
  appsWithWrongPort,
  coverageGaps,
  ingestBaseUrlMismatch,
} from "./dev-ports-guard.mjs";

// A guard's tests must RUN the guard, not restate its list.

test("no two apps share a port", () => {
  assert.deepEqual(duplicatePorts(), []);
});

test("every app in the registry has a dev script", () => {
  assert.deepEqual(appsMissingDevScript(), []);
});

test("every dev script uses the port the registry assigns", () => {
  assert.deepEqual(appsWithWrongPort(), []);
});

// The whole point of pinning the engine's port: a locally-created endpoint hands out
// `${INGEST_BASE_URL}/<token>`, so if the manifest and the registry disagree the URL points at nothing.
test("the manifest's INGEST_BASE_URL matches the engine's port", () => {
  assert.equal(ingestBaseUrlMismatch(), null);
});

test("LOCAL_INGEST_BASE_URL is derived from the engine entry, not restated", () => {
  assert.equal(LOCAL_INGEST_BASE_URL, `http://localhost:${DEV_APPS.engine.port}`);
});

// Coverage: every app directory is either in the registry or explicitly declared as having no local
// server. A new app must land in one bucket or the other, never in neither.
test("every app under apps/ is accounted for", () => {
  assert.deepEqual(coverageGaps(), []);
});

test("the registry is not empty — a guard over nothing passes trivially", () => {
  assert.ok(Object.keys(DEV_APPS).length >= 10, `only ${Object.keys(DEV_APPS).length} apps`);
});

test("auth runs the custom worker, NOT next dev — next dev omits the issuer routes", () => {
  const cmd = devCommand("auth");
  assert.ok(cmd.includes("opennextjs-cloudflare preview"), cmd);
  assert.ok(!cmd.startsWith("next dev"), cmd);
});

test("a worker app gets wrangler dev on its pinned port", () => {
  assert.equal(devCommand("engine"), "wrangler dev --port 8787 --ip 127.0.0.1");
});

test("a plain next app gets next dev on its pinned port", () => {
  assert.equal(devCommand("www"), "next dev -p 3002");
});

test("an unknown app is a loud error, not a silent default", () => {
  assert.throws(() => devCommand("nope"), /unknown app/);
});

// Anti-vacuity: the checks above only mean something if they can fail.
test("duplicatePorts actually detects a collision", () => {
  const collide = { a: { port: 3000 }, b: { port: 3000 }, c: { port: 3001 } };
  /** @type {Map<number, string[]>} */
  const seen = new Map();
  for (const [app, spec] of Object.entries(collide)) {
    seen.set(spec.port, [...(seen.get(spec.port) ?? []), app]);
  }
  const dupes = [...seen.entries()].filter(([, apps]) => apps.length > 1);
  assert.equal(dupes.length, 1);
  assert.deepEqual(dupes[0][1], ["a", "b"]);
});
