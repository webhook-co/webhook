// Tests for the pnpm security-overrides guard.
//
// The RED these prove: a security pin can be present in the file, mirrored into the lockfile, and
// still be doing NOTHING. Every case below is a way that has actually happened or can happen here.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectDocumentedNames,
  findStrandedOverrides,
  overrideViolations,
  readResolvedVersions,
  readWorkspaceOverrides,
  workspacePackageDirs,
} from "./overrides-guard.mjs";

/** Shorthand: a well-formed input where every rule passes, so each test can perturb ONE thing. */
const ok = (over) => ({
  overrides: over,
  resolved: new Map([["left-pad", ["2.0.0"]]]),
  documented: new Set(["left-pad"]),
  stranded: [],
});

// ── the floor: a guard that reads nothing must never read as clean ────────────────────────────
test("fails closed when there are no overrides to check", () => {
  const v = overrideViolations({ ...ok({}), overrides: {} });
  assert.ok(v.length > 0);
  assert.match(v.join("\n"), /no overrides/i);
});

test("fails closed when the lockfile yielded no packages", () => {
  const v = overrideViolations({ ...ok({ "left-pad@<2.0.0": "^2.0.0" }), resolved: new Map() });
  assert.ok(v.length > 0);
  assert.match(v.join("\n"), /no resolved packages/i);
});

// ── rule 1: the pin must have actually MOVED the tree ─────────────────────────────────────────
test("accepts a range-scoped pin whose resolved version is at or above the floor", () => {
  assert.deepEqual(overrideViolations(ok({ "left-pad@<2.0.0": "^2.0.0" })), []);
});

test("flags a version still BELOW the floor — the pin did not take", () => {
  const v = overrideViolations({
    ...ok({ "left-pad@<2.0.0": "^2.0.0" }),
    resolved: new Map([["left-pad", ["1.3.0"]]]),
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /left-pad.*1\.3\.0.*below/is);
});

test("flags the below-floor copy even when a patched copy also resolves", () => {
  const v = overrideViolations({
    ...ok({ "left-pad@<2.0.0": "^2.0.0" }),
    resolved: new Map([["left-pad", ["2.0.1", "1.3.0"]]]),
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /1\.3\.0/);
  assert.doesNotMatch(v[0], /2\.0\.1/);
});

test("leaves a deliberately out-of-band major alone (a scoped key must not drag it)", () => {
  // `brace-expansion@<1.1.16` must not complain about the tree's 2.1.2 and 5.0.7.
  assert.deepEqual(
    overrideViolations({
      ...ok({ "left-pad@<1.1.16": "^1.1.16" }),
      resolved: new Map([["left-pad", ["1.1.16", "2.1.2", "5.0.7"]]]),
    }),
    [],
  );
});

// ── rule 2: a bare `name: version` pin must be exactly that version ───────────────────────────
test("accepts a bare pin the whole tree agrees with", () => {
  assert.deepEqual(
    overrideViolations({
      ...ok({ "left-pad": "2.0.0" }),
      resolved: new Map([["left-pad", ["2.0.0"]]]),
    }),
    [],
  );
});

test("flags a bare pin the tree does not match", () => {
  const v = overrideViolations({
    ...ok({ "left-pad": "2.0.0" }),
    resolved: new Map([["left-pad", ["2.0.0", "1.9.0"]]]),
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /1\.9\.0/);
});

// ── rule 3: a pin naming a package that is not installed is dead weight ───────────────────────
test("flags an override for a package that resolves nowhere", () => {
  const v = overrideViolations({
    ...ok({ "gone@<2.0.0": "^2.0.0" }),
    documented: new Set(["gone"]),
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /gone.*no longer|not.*(present|installed|lockfile)/is);
});

// ── rule 4: key and value must agree, or the override can land below its own floor ────────────
test("flags a key/value mismatch that could resolve below the key's floor", () => {
  const v = overrideViolations({ ...ok({ "left-pad@<2.0.0": "^1.9.0" }) });
  assert.ok(v.length >= 1);
  assert.match(v.join("\n"), /\^1\.9\.0.*2\.0\.0|below its own/is);
});

// ── rule 5: refuse to guess at a version this guard cannot compare ────────────────────────────
test("fails closed on a floor it cannot parse rather than silently passing", () => {
  const v = overrideViolations({ ...ok({ "left-pad@<^2 || >=3": "*" }) });
  assert.ok(v.length > 0);
  assert.match(v.join("\n"), /could not|cannot/i);
});

// ── rule 6: every pin keeps its rationale ─────────────────────────────────────────────────────
test("flags an override with no explanatory comment in the file", () => {
  const v = overrideViolations({ ...ok({ "left-pad@<2.0.0": "^2.0.0" }), documented: new Set() });
  assert.equal(v.length, 1);
  assert.match(v[0], /comment|undocumented/i);
});

// ── rule 7: pnpm 10 ignores package.json's `pnpm.overrides` — that is how #124 went inert ─────
test("flags a stranded overrides block in a package.json", () => {
  const v = overrideViolations({
    ...ok({ "left-pad@<2.0.0": "^2.0.0" }),
    stranded: ["apps/web/package.json"],
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /apps\/web\/package\.json/);
  assert.match(v[0], /pnpm-workspace\.yaml/);
});

// ── the readers, against the REAL repo ────────────────────────────────────────────────────────
// A pure rule that is never fed real data is a rule that guards nothing. These bind it to the tree.

test("reads the repo's real overrides", async () => {
  const { overrides } = await readWorkspaceOverrides();
  assert.ok(Object.keys(overrides).length > 0, "expected the repo to declare security overrides");
});

test("reads real resolved versions out of the lockfile", async () => {
  const resolved = await readResolvedVersions();
  assert.ok(resolved.size > 100, `expected a populated lockfile, got ${resolved.size} names`);
  // The lockfile keys are `name@version(peer)(peer)` — prove the peer suffix was stripped.
  for (const versions of resolved.values()) {
    for (const v of versions) assert.doesNotMatch(v, /[()]/, `unstripped peer suffix in ${v}`);
  }
});

test("scoped names survive the @-split (an `@scope/pkg@1.2.3` key must not become `@scope`)", () => {
  const resolved = readResolvedVersions.parseKeys(["@hono/node-server@2.0.11(hono@4.12.31)"]);
  assert.deepEqual([...resolved.keys()], ["@hono/node-server"]);
  assert.deepEqual(resolved.get("@hono/node-server"), ["2.0.11"]);
});

// A descriptor that itself contains `@` (git+ssh, aliased npm:/jsr:) must not be split inside the
// spec — `lastIndexOf("@")` would file the copy under a bogus name and silently drop a possibly
// below-floor version, so the pin would read as in force when it is not.
test("a git+ssh descriptor with an inner @ files under the real name, so a below-floor copy is caught", () => {
  const resolved = readResolvedVersions.parseKeys([
    "undici@7.28.0",
    "undici@git+ssh://git@github.com/nodejs/undici.git#7.27.0",
  ]);
  assert.deepEqual(resolved.get("undici"), [
    "7.28.0",
    "git+ssh://git@github.com/nodejs/undici.git#7.27.0",
  ]);
  // the git-pinned copy is unparseable, so the guard fails closed rather than reading clean
  const v = overrideViolations({
    overrides: { "undici@<7.28.0": "^7.28.0" },
    resolved,
    documented: new Set(["undici"]),
    stranded: [],
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /cannot compare|fail closed/i);
});

test("prerelease identifiers order numerically, not lexically (rc.2 < rc.10)", () => {
  // A bare pin to 1.2.3-rc.10 must NOT flag a resolved 1.2.3-rc.2 as equal-or-above.
  const v = overrideViolations({
    overrides: { thing: "1.2.3-rc.10" },
    resolved: new Map([["thing", ["1.2.3-rc.10", "1.2.3-rc.2"]]]),
    documented: new Set(["thing"]),
    stranded: [],
  });
  assert.equal(v.length, 1);
  assert.match(v[0], /rc\.2/);
});

// The stranded-override sweep must be DERIVED from the workspace globs, so a new top-level glob is
// covered without editing this guard — a hardcoded dir list is the #124 failure mode itself.
test("workspacePackageDirs derives search roots from the workspace globs incl. the root", async () => {
  const { packages } = await readWorkspaceOverrides();
  const dirs = await workspacePackageDirs(packages);
  assert.ok(dirs.includes("."), "root package.json must always be swept");
  assert.ok(
    dirs.some((d) => d.startsWith("apps/")),
    "an apps/* glob must expand to its child dirs",
  );
});

test("a literal (non-glob) workspace entry is swept as its own package dir", async () => {
  const dirs = await workspacePackageDirs(["infra", "apps/*"]);
  assert.ok(dirs.includes("infra"));
});

test("the real repo has no stranded pnpm.overrides block anywhere in the workspace", async () => {
  const { packages } = await readWorkspaceOverrides();
  const stranded = await findStrandedOverrides(await workspacePackageDirs(packages));
  assert.deepEqual(stranded, [], `stranded pnpm.overrides found in: ${stranded.join(", ")}`);
});

test("collects the package names mentioned in the file's comments", async () => {
  const { text } = await readWorkspaceOverrides();
  const documented = collectDocumentedNames(text);
  assert.ok(documented.has("esbuild"), "esbuild is documented in the file and should be collected");
});

// The whole point: the repo as it stands must satisfy its own guard.
test("the real repository passes the guard", async () => {
  const { overrides, text } = await readWorkspaceOverrides();
  const v = overrideViolations({
    overrides,
    resolved: await readResolvedVersions(),
    documented: collectDocumentedNames(text),
    stranded: [],
  });
  assert.deepEqual(v, [], `real-tree violations:\n${v.join("\n")}`);
});
