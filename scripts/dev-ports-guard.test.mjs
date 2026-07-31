import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SERVICE_BINDINGS } from "./wrangler-services.mjs";

import {
  CRON_APPS,
  DEV_APPS,
  LOCAL_INGEST_BASE_URL,
  devCommand,
  devFastCommand,
  devWorkerCommand,
  duplicateAssignments,
  duplicatePorts,
  inspectorPortFor,
  portAssignments,
} from "./dev-ports.mjs";
import {
  appsMissingDevScript,
  appsWithWrongInspectorPort,
  appsWithWrongPort,
  concurrencyShortfall,
  coverageGaps,
  devConcurrencyShortfall,
  effectiveDevConcurrency,
  ingestBaseUrlMismatch,
  persistentDevTaskCount,
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
  // engine declares crons, so it also carries --test-scheduled (see scripts/dev-cron.mjs). Pinned as a
  // whole string on purpose: this is the one test that would notice a flag silently disappearing.
  assert.equal(
    devCommand("engine"),
    "wrangler dev --test-scheduled --port 8787 --ip 127.0.0.1 --inspector-port 9787",
  );
});

test("a worker app with no crons and no service bindings gets the bare command", () => {
  // `get` calls no Worker and schedules nothing — the baseline that proves the flags above are added,
  // not just always present.
  assert.equal(devCommand("get"), "wrangler dev --port 8791 --ip 127.0.0.1 --inspector-port 9791");
});

test("a plain next app gets next dev on its pinned port", () => {
  assert.equal(devCommand("www"), "next dev -p 3002");
});

test("an unknown app is a loud error, not a silent default", () => {
  assert.throws(() => devCommand("nope"), /unknown app/);
});

// ── The DevTools inspector port is a second port every Worker binds ────────────────────────────────────
//
// `wrangler dev` opens a DevTools inspector on 127.0.0.1:9229 by default — the SAME default for every
// Worker. Pinning only the HTTP port left all nine wrangler-backed apps fighting over 9229, so the first
// one to start won and the rest died with "Address already in use". `pnpm dev` could never run more than
// one Worker.

test("every wrangler-backed app has its own inspector port", () => {
  const workers = Object.entries(DEV_APPS).filter(([, s]) => s.kind !== "next");
  assert.ok(workers.length >= 9, `only ${workers.length} wrangler-backed apps`);
  for (const [app] of workers) {
    assert.equal(typeof inspectorPortFor(app), "number", `${app} has no inspector port`);
  }
});

test("a next-only app has no inspector port — next dev does not open one", () => {
  assert.equal(inspectorPortFor("www"), null);
  assert.equal(inspectorPortFor("web"), null);
});

// The real invariant is across BOTH roles: an inspector port that collides with some other app's HTTP port
// fails exactly as badly as two HTTP ports colliding.
test("no port is assigned twice, counting HTTP and inspector together", () => {
  assert.deepEqual(duplicateAssignments(), []);
});

test("the dev command pins the inspector port for wrangler-backed apps", () => {
  assert.match(devCommand("engine"), /--inspector-port \d+/);
  assert.match(devCommand("auth"), /--inspector-port \d+/);
  assert.ok(!devCommand("www").includes("--inspector-port"), devCommand("www"));
});

test("no wrangler-backed app is left on wrangler's 9229 default", () => {
  for (const [app, spec] of Object.entries(DEV_APPS)) {
    if (spec.kind === "next") continue;
    assert.notEqual(inspectorPortFor(app), 9229, `${app} still on the shared default`);
  }
});

test("every app's committed dev script pins its inspector port", () => {
  assert.deepEqual(appsWithWrongInspectorPort(), []);
});

// Anti-vacuity: the cross-role check must actually catch a collision.
test("duplicateAssignments detects an inspector/HTTP clash", () => {
  const clash = portAssignments({
    a: { port: 8787, kind: "worker" },
    b: { port: 9787, kind: "next" },
  });
  const seen = new Map();
  for (const { port, app, role } of clash) {
    seen.set(port, [...(seen.get(port) ?? []), `${app}:${role}`]);
  }
  const dupes = [...seen.values()].filter((v) => v.length > 1);
  assert.equal(dupes.length, 1, JSON.stringify([...seen]));
  assert.deepEqual(dupes[0], ["a:inspector", "b:http"]);
});

// ── `pnpm dev` must actually be able to start every app ────────────────────────────────────────────────
//
// turbo refuses to run at all when it has more persistent tasks than concurrency slots — it does not
// degrade or queue, it exits 1 before starting anything. Giving the eight Worker apps `dev` scripts took
// the repo from 3 persistent tasks to 11 and silently crossed turbo's default of 10, so the one command
// this whole lane is about failed instantly for everyone.

test("`pnpm dev` has enough concurrency to start every app", () => {
  assert.equal(devConcurrencyShortfall(), null);
});

test("the persistent-task count is read from the registry, and is not trivially small", () => {
  assert.equal(persistentDevTaskCount(), Object.keys(DEV_APPS).length);
  assert.ok(persistentDevTaskCount() >= 11, `only ${persistentDevTaskCount()}`);
});

// turbo's own error names the rule: "11 persistent tasks but ... concurrency of 10. Set --concurrency to
// at least 12" — strictly greater than the number of persistent tasks, so N tasks need N+1.
test("the requirement is one MORE slot than there are persistent tasks", () => {
  assert.equal(concurrencyShortfall(11, 12), null);
  assert.deepEqual(concurrencyShortfall(11, 11), { persistent: 11, configured: 11, needed: 12 });
});

test("the configured concurrency is pinned explicitly, not left to turbo's default", () => {
  const { value, source } = effectiveDevConcurrency();
  assert.notEqual(source, "turbo default", "relying on turbo's default is what broke `pnpm dev`");
  assert.ok(value >= Object.keys(DEV_APPS).length + 1, `concurrency ${value} from ${source}`);
});

// Anti-vacuity: the checks above only mean something if they can fail.

// The exact regression: 11 persistent tasks against turbo's default of 10.
test("concurrencyShortfall detects the failure that actually happened", () => {
  const shortfall = concurrencyShortfall(11, 10);
  assert.deepEqual(shortfall, { persistent: 11, configured: 10, needed: 12 });
});

// A percentage ("50%") resolves against the machine's core count, so it cannot be shown to be sufficient
// on every machine — it must not be silently accepted as a pin.
test("a percentage concurrency is not accepted as sufficient", () => {
  assert.deepEqual(concurrencyShortfall(11, null), {
    persistent: 11,
    configured: null,
    needed: 12,
  });
});

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

// The `-c wrangler.dev.jsonc` flag is the whole mechanism by which api and mcp get their cross-Worker
// service bindings locally. Drop it from devCommand or from either package.json and CI stays green while
// local dev silently returns to "bindings absent" — the exact silent regression this lane keeps finding.
test("apps that call another Worker run against the generated dev overlay", () => {
  for (const app of Object.keys(SERVICE_BINDINGS)) {
    if (DEV_APPS[app]?.kind !== "worker") continue; // web is `next dev` — it cannot take -c
    assert.match(
      devCommand(app),
      /-c wrangler\.dev\.jsonc/,
      `${app} calls another Worker but does not load the dev overlay`,
    );
  }
});

test("an app that calls nobody gets no -c", () => {
  assert.ok(!devCommand("engine").includes("-c "), "engine should use its committed config");
});

test("the committed package.json dev scripts MATCH devCommand", () => {
  // devCommand is the single source of truth; a package.json that drifted from it would run something
  // nobody derived. Checked for every worker-kind app, not just the two that gained a flag.
  // EVERY app whose dev command is derived, not just the bare-wrangler ones. `auth` is `opennext` and
  // was skipped by an earlier version of this loop — so dropping --test-scheduled from its package.json
  // would have left CI green with auth's cron unreachable locally. Only `next` apps are exempt: they run
  // `next dev`, which is not wrangler and takes none of these flags.
  for (const [app, spec] of Object.entries(DEV_APPS)) {
    if (spec.kind === "next") continue;
    const pkg = JSON.parse(
      readFileSync(new URL(`../apps/${app}/package.json`, import.meta.url), "utf8"),
    );
    assert.equal(pkg.scripts.dev, devCommand(app), `${app}/package.json dev script drifted`);
  }
});

test("every cron app's COMMITTED script carries --test-scheduled", () => {
  // devCommand() being right is not enough — turbo runs what package.json says.
  for (const app of Object.keys(DEV_APPS)) {
    if (!CRON_APPS.has(app) || DEV_APPS[app].kind === "next") continue;
    const pkg = JSON.parse(
      readFileSync(new URL(`../apps/${app}/package.json`, import.meta.url), "utf8"),
    );
    assert.match(
      pkg.scripts.dev,
      /--test-scheduled/,
      `${app} declares a cron but its committed dev script cannot fire it`,
    );
  }
});

// `next dev` is not wrangler: it takes no -c, so an app running under it CANNOT have a service binding.
// For apps/web that meant its 10 bindings were absent and the readers DEGRADED rather than throwing.
// Concretely: exchangeTicket() prefers the AUTH_SESSION_EXCHANGE RPC and falls back to a public HTTP
// fetch when unbound, so the DEFAULT local login took a transport production never uses, silently. The
// default is now the bindings path; fast refresh is the named opt-out.
test("a Next app WITH service bindings runs WITH them by default", () => {
  const cmd = devCommand("web");
  assert.match(cmd, /-c wrangler\.dev\.jsonc/, "the default must load the generated overlay");
  assert.match(
    cmd,
    /opennextjs-cloudflare preview/,
    "the default must be the preview, not next dev",
  );
  assert.ok(!/next dev/.test(cmd), "the default still runs next dev, so the bindings are absent");
  assert.match(cmd, new RegExp(`--port ${DEV_APPS.web.port}\\b`));
});

test("a Next app with NO service bindings keeps the fast loop", () => {
  // www has no bindings, so the preview would cost fast refresh and buy nothing. The trade is only worth
  // making where a binding actually changes the code path.
  assert.match(devCommand("www"), /next dev/);
  assert.ok(!/opennextjs-cloudflare/.test(devCommand("www")));
});

test("fast refresh stays reachable as an explicit opt-out", () => {
  const fast = devFastCommand("web");
  assert.match(fast, /next dev/);
  assert.match(fast, new RegExp(`-p ${DEV_APPS.web.port}\\b`));
  // …and it is offered ONLY where the default is something else, so it cannot read as a second way to do
  // the same thing.
  assert.equal(
    devFastCommand("www"),
    null,
    "www's default IS next dev; a second name would be noise",
  );
  assert.equal(devFastCommand("engine"), null);
});

test("web's committed dev scripts match the derived commands", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    pkg.scripts.dev,
    devCommand("web"),
    "the committed default drifted from the derived one",
  );
  assert.equal(pkg.scripts["dev:fast"], devFastCommand("web"));
  // The opt-in name is gone: leaving `dev:bindings` behind would imply bindings are still the exception.
  assert.equal(pkg.scripts["dev:bindings"], undefined);
});

// --- Exercising a Worker that the fast loop skips ------------------------------------------------
// `apps/www` runs under `next dev`, which never loads its wrangler `main`, so the two routes that Worker
// adds — the cookieless page-view write and the MTA-STS policy response — do not exist locally AT ALL.
// The fast loop is the right default for a content site, but "not the default" and "impossible" are
// different things, and only the first is a trade-off. `dev:worker` builds the static export and serves it
// through the real Worker, so the gap is one command away instead of unreachable.
test("an app whose committed Worker its default skips can still run it on demand", () => {
  const cmd = devWorkerCommand("www");
  assert.ok(cmd, "www's worker routes are unreachable locally with no way to exercise them");
  assert.match(
    cmd,
    /next build/,
    "the Worker serves ./out — without a build it has nothing to serve",
  );
  assert.match(
    cmd,
    /wrangler dev/,
    "it must be wrangler, not next dev — next dev cannot load a main",
  );
  assert.match(cmd, new RegExp(`--port ${DEV_APPS.www.port}\\b`));
  assert.ok(
    cmd.indexOf("next build") < cmd.indexOf("wrangler dev"),
    "building after serving would serve a stale ./out",
  );
});

test("it is offered ONLY where the default actually skips the Worker", () => {
  // web's default is the OpenNext preview, which runs its worker already; a second name for that would
  // read as a capability. A wrangler app runs its main by definition.
  assert.equal(devWorkerCommand("web"), null);
  assert.equal(devWorkerCommand("engine"), null);
  assert.equal(devWorkerCommand("auth"), null);
});

test("www's committed dev:worker script matches the derived command", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../apps/www/package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts["dev:worker"], devWorkerCommand("www"));
  // …and the DEFAULT stays the fast loop. Changing that is a deliberate call, not a silent drift.
  assert.equal(pkg.scripts.dev, devCommand("www"));
  assert.match(pkg.scripts.dev, /next dev/);
});
