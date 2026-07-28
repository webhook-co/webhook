import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { APP_NAMES, sharedNames, specsFor } from "./dev-secrets-manifest.mjs";
import { generateDevVars, parseDevVars, renderDevVars, renderExample } from "./dev-secrets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tmp = () => mkdtempSync(join(tmpdir(), "devsecrets-"));

// ── The bug this whole thing exists to prevent ────────────────────────────────────────────────────

test("a shared secret gets the SAME value in every app that reads it", () => {
  // web MINTS a listen ticket with LISTEN_TICKET_KEY, engine VERIFIES it. Before this generator the
  // key was in apps/engine/.dev.vars and absent from apps/web/.dev.vars, so web fell back to a
  // hardcoded dev constant and the dashboard WebSocket died with no configuration error anywhere.
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });

    const readKey = (app, key) =>
      parseDevVars(readFileSync(join(dir, "apps", app, ".dev.vars"), "utf8"))[key];

    for (const key of sharedNames()) {
      const holders = APP_NAMES.filter((a) => specsFor(a).some((s) => s.name === key));
      assert.ok(holders.length >= 2, `${key} should be shared by at least two apps`);
      const values = holders.map((a) => readKey(a, key));
      assert.ok(values[0], `${key} must have a value in ${holders[0]}`);
      for (const v of values) {
        assert.equal(v, values[0], `${key} must be byte-identical across ${holders.join(", ")}`);
      }
    }
    // Specifically the pair that broke.
    assert.equal(readKey("web", "LISTEN_TICKET_KEY"), readKey("engine", "LISTEN_TICKET_KEY"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinct shared secrets do not collide with each other", () => {
  // A generator that reused one random value for every shared key would pass the test above.
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    const vars = parseDevVars(readFileSync(join(dir, "apps", "engine", ".dev.vars"), "utf8"));
    const values = sharedNames()
      .filter((n) => vars[n])
      .map((n) => vars[n]);
    assert.equal(new Set(values).size, values.length, "each shared secret must be independent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Idempotence ──────────────────────────────────────────────────────────────────────────────────

test("re-running preserves existing values — it must not rotate your keys", () => {
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    const before = readFileSync(join(dir, "apps", "engine", ".dev.vars"), "utf8");
    generateDevVars({ root: dir });
    const after = readFileSync(join(dir, "apps", "engine", ".dev.vars"), "utf8");
    assert.equal(after, before, "a second run must be a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a value the developer edited by hand is never overwritten", () => {
  // Losing a hand-pasted Stripe test key on every `pnpm dev:secrets` would make the tool hostile.
  const dir = tmp();
  try {
    mkdirSync(join(dir, "apps", "api"), { recursive: true });
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    const p = join(dir, "apps", "api", ".dev.vars");
    const edited = readFileSync(p, "utf8").replace(
      /^STRIPE_SECRET_KEY=.*$/m,
      "STRIPE_SECRET_KEY=sk_test_mine",
    );
    writeFileSync(p, edited);
    generateDevVars({ root: dir });
    assert.equal(parseDevVars(readFileSync(p, "utf8")).STRIPE_SECRET_KEY, "sk_test_mine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing key is added to an existing file without disturbing the others", () => {
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    const p = join(dir, "apps", "mcp", ".dev.vars");
    const stripped = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("MCP_SESSION_KEY="))
      .join("\n");
    writeFileSync(p, stripped);
    const keptPepper = parseDevVars(stripped).CREDENTIAL_PEPPER;
    generateDevVars({ root: dir });
    const now = parseDevVars(readFileSync(p, "utf8"));
    assert.ok(now.MCP_SESSION_KEY, "the missing key must be filled in");
    assert.equal(now.CREDENTIAL_PEPPER, keptPepper, "untouched keys must keep their values");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Value shape ──────────────────────────────────────────────────────────────────────────────────

test("generated secrets are 32 random bytes, base64 — the format the hashers require", () => {
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    const vars = parseDevVars(readFileSync(join(dir, "apps", "engine", ".dev.vars"), "utf8"));
    const pepper = vars.CREDENTIAL_PEPPER;
    assert.match(pepper, /^[A-Za-z0-9+/]+=*$/, "must be base64");
    assert.equal(Buffer.from(pepper, "base64").length, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two runs in two different trees produce different secrets", () => {
  // Nothing here may be a fixed constant — a committed default would be a shared secret by another
  // name, and every developer would have the same pepper.
  const a = tmp();
  const b = tmp();
  try {
    for (const dir of [a, b]) {
      for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
      generateDevVars({ root: dir });
    }
    const read = (d) =>
      parseDevVars(readFileSync(join(d, "apps", "engine", ".dev.vars"), "utf8")).CREDENTIAL_PEPPER;
    assert.notEqual(read(a), read(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("external secrets are written empty, never with a plausible-looking value", () => {
  // Writing `sk_test_51H...` would be a fake credential in a file people paste into issues.
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    for (const app of APP_NAMES) {
      const vars = parseDevVars(readFileSync(join(dir, "apps", app, ".dev.vars"), "utf8"));
      for (const spec of specsFor(app).filter((s) => s.scope === "external")) {
        assert.equal(
          vars[spec.name],
          "",
          `${app}/${spec.name} must be empty, got ${vars[spec.name]}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local literals are written with their declared value", () => {
  const dir = tmp();
  try {
    for (const app of APP_NAMES) mkdirSync(join(dir, "apps", app), { recursive: true });
    generateDevVars({ root: dir });
    const vars = parseDevVars(readFileSync(join(dir, "apps", "engine", ".dev.vars"), "utf8"));
    assert.equal(vars.FREE_EVENT_CAP, "5000", "must match production, not the uncapped default");
    assert.equal(vars.DASHBOARD_ORIGIN, "http://localhost:3000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The manifest must not drift from the code ────────────────────────────────────────────────────

test("the manifest covers every secret in auth's REQUIRED_SECRETS", () => {
  // Discover, don't restate: auth already declares the list that makes it throw at the request
  // boundary. If someone adds one there, this fails until the manifest teaches a developer to set it.
  const src = readFileSync(join(ROOT, "apps/auth/src/runtime/env.ts"), "utf8");
  const block = /const REQUIRED_SECRETS = \[([\s\S]*?)\] as const;/.exec(src);
  assert.ok(block, "could not find REQUIRED_SECRETS in apps/auth/src/runtime/env.ts");
  const required = [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(required.length >= 5, `expected the real list, got ${required.length}`);

  const declared = new Set(specsFor("auth").map((s) => s.name));
  const missing = required.filter((r) => !declared.has(r));
  assert.deepEqual(missing, [], `auth requires secrets the manifest never mentions: ${missing}`);
});

test("every app in the manifest is a real app directory", () => {
  for (const app of APP_NAMES) {
    assert.ok(
      readFileSync(join(ROOT, "apps", app, "package.json"), "utf8").length > 0,
      `apps/${app} must exist`,
    );
  }
});

test("shared secrets are declared by more than one app — otherwise 'shared' means nothing", () => {
  for (const name of sharedNames()) {
    const holders = APP_NAMES.filter((a) => specsFor(a).some((s) => s.name === name));
    assert.ok(holders.length >= 2, `${name} is marked shared but only ${holders} reads it`);
  }
});

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

test("the committed example carries every key name but no generated value", () => {
  // The example is what someone greps for before running anything. It must name every key, and it
  // must never carry a real secret — it is committed.
  const example = renderExample("engine");
  for (const spec of specsFor("engine")) {
    assert.ok(example.includes(`${spec.name}=`), `example must name ${spec.name}`);
  }
  const vars = parseDevVars(example);
  for (const spec of specsFor("engine").filter((s) => s.scope === "generated")) {
    assert.equal(vars[spec.name], "", `${spec.name} must be blank in the committed example`);
  }
  assert.equal(vars.FREE_EVENT_CAP, "5000", "non-secret literals SHOULD be filled in");
});

test("every spec's note is present in the example, so the file explains itself", () => {
  const example = renderExample("auth");
  for (const spec of specsFor("auth")) {
    assert.ok(spec.note.length > 20, `${spec.name} needs a real note`);
  }
  assert.match(example, /REQUIRED_SECRETS/, "auth's example should explain the hard-fail");
});

test("parseDevVars round-trips what renderDevVars writes", () => {
  // renderDevVars is spec-driven — it emits the app's declared keys, not arbitrary ones — so build
  // the input from the manifest rather than inventing key names.
  const values = Object.fromEntries(specsFor("engine").map((s, i) => [s.name, `v${i}==`]));
  assert.deepEqual(parseDevVars(renderDevVars("engine", values)), values);
});

test("renderDevVars emits a key for every spec, even when no value is supplied", () => {
  const parsed = parseDevVars(renderDevVars("engine", {}));
  for (const spec of specsFor("engine")) {
    assert.ok(spec.name in parsed, `${spec.name} must appear even when unset`);
    assert.equal(parsed[spec.name], "");
  }
});

test("parseDevVars ignores comments and blank lines", () => {
  assert.deepEqual(parseDevVars("# a comment\n\nX=1\n  \n# another\nY=2\n"), { X: "1", Y: "2" });
});

test("parseDevVars keeps '=' inside a value", () => {
  // base64 secrets end in '='. Splitting on every '=' would silently truncate every key.
  assert.deepEqual(parseDevVars("K=abc==\n"), { K: "abc==" });
});
