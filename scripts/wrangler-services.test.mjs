import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SERVICE_BINDINGS, serviceBindingsFor } from "./wrangler-services.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = join(REPO, "apps");

// A service binding has three names that must all line up, and NONE of them fails at deploy time:
// `service` must equal the target Worker's config `name`, and `entrypoint` must be a class exported
// from that Worker's `main`. Get either wrong and the upload succeeds, the deploy is green, and the
// call fails in production the first time someone exercises that feature.
//
// So these are checked here, against the committed configs and the actual entry modules, rather than
// trusted to review.

/** The first JSON string value for `key` in a JSONC file (enough for "name"/"main"). */
function configValue(app, key) {
  const text = readFileSync(join(APPS, app, "wrangler.jsonc"), "utf8");
  return new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1];
}

/** app directory -> the Worker `name` it deploys as. */
function workerNames() {
  const byName = new Map();
  for (const app of readdirSync(APPS).sort()) {
    let name;
    try {
      name = configValue(app, "name");
    } catch {
      continue; // not a Worker app
    }
    if (name) byName.set(name, app);
  }
  return byName;
}

test("the table is non-empty and every entry is fully specified", () => {
  const apps = Object.keys(SERVICE_BINDINGS);
  assert.ok(apps.length >= 3, `expected ≥3 calling apps, got ${apps.length}`);
  let total = 0;
  for (const [app, list] of Object.entries(SERVICE_BINDINGS)) {
    assert.ok(list.length > 0, `${app}: declared with no bindings`);
    for (const b of list) {
      for (const field of ["binding", "service", "entrypoint"]) {
        assert.ok(b[field], `${app}/${b.binding ?? "?"}: missing ${field}`);
      }
      total++;
    }
  }
  assert.equal(total, 18, "the binding count changed — update this pin deliberately");
});

test("no app declares the same binding name twice", () => {
  for (const [app, list] of Object.entries(SERVICE_BINDINGS)) {
    const names = list.map((b) => b.binding);
    assert.equal(new Set(names).size, names.length, `${app}: duplicate binding name`);
  }
});

test("every `service` names a Worker this repo actually deploys", () => {
  const names = workerNames();
  assert.ok(names.size >= 5, `discovery found only ${names.size} workers`);
  for (const [app, list] of Object.entries(SERVICE_BINDINGS)) {
    for (const b of list) {
      assert.ok(
        names.has(b.service),
        `${app}/${b.binding} targets "${b.service}", which is not any app's wrangler name`,
      );
    }
  }
});

// The load-bearing one. A class defined somewhere in the target app but NOT re-exported from its `main`
// is not bindable, and nothing before a production call would say so.
test("every `entrypoint` is exported from the target Worker's main module", () => {
  const names = workerNames();
  for (const [app, list] of Object.entries(SERVICE_BINDINGS)) {
    for (const b of list) {
      const targetApp = names.get(b.service);
      const main = configValue(targetApp, "main");
      // web's main is a build artifact (.open-next/worker.js) that does not exist in a clean tree; it
      // is never a binding TARGET, only a caller, so this loop should not reach it.
      assert.ok(
        !main.startsWith("."),
        `${b.service} is a binding target but its main is a build artifact (${main})`,
      );
      const source = readFileSync(join(APPS, targetApp, main), "utf8");
      assert.ok(
        new RegExp(`export\\s+(class|\\{[^}]*\\b${b.entrypoint}\\b)`).test(source) &&
          source.includes(b.entrypoint),
        `${app}/${b.binding}: "${b.entrypoint}" is not exported from ${targetApp}/${main} — ` +
          `a binding to it would deploy green and fail at call time`,
      );
    }
  }
});

test("serviceBindingsFor returns an empty list for an app that calls nobody", () => {
  assert.deepEqual(serviceBindingsFor("engine"), []);
  assert.deepEqual(serviceBindingsFor("totally-unknown"), []);
  assert.ok(serviceBindingsFor("web").length > 0, "web should have bindings");
});
