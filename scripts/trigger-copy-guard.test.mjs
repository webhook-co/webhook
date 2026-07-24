import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORBIDDEN_CLAIMS,
  INTRODUCES,
  MECHANISM_WORDS,
  discoverSurfaces,
  scanSurfaces,
} from "./trigger-copy-guard.mjs";

// These tests run the REAL scanner over REAL files on disk (fixtures under scripts/fixtures/trigger-copy),
// not a stubbed reader — a copy guard verified against an in-memory string proves nothing about whether it
// can find, open, and read the surfaces it claims to cover.

const fixture = (name, introduces = false) => [
  { path: `scripts/fixtures/trigger-copy/${name}`, introduces },
];

// --- the guard running against PRODUCTION copy ---

test("every real user-facing surface is clean", () => {
  assert.deepEqual(scanSurfaces(), []);
});

// --- the floor: the guard must not pass by scanning nothing ---

test("an empty surface list throws rather than reporting clean", () => {
  assert.throws(() => scanSurfaces([]), /empty surface list/);
});

test("a surface that has moved is a violation, never a silent skip", () => {
  const violations = scanSurfaces([{ path: "apps/docs/mcp/this-page-was-renamed.mdx" }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].why, /moved or was renamed/);
});

test("discovery finds trigger copy across every surface, not a curated subset", () => {
  const found = discoverSurfaces();
  assert.ok(found.length >= 20, `discovery looks broken or over-filtered: ${found.length} files`);
  for (const dir of ["apps/web/", "apps/www/", "apps/docs/", "packages/cli/", "apps/mcp/"]) {
    assert.ok(
      found.some((s) => s.path.startsWith(dir)),
      `${dir} has trigger copy but discovery returned none`,
    );
  }
  assert.ok(
    found.some((s) => s.introduces),
    "no surface carries the positive obligation — the mechanism half is dormant",
  );
});

test("discovery picks up pages a curated list would have missed", () => {
  // The regression that motivated content-based discovery: quickstart.mdx carried "block on
  // triggers.wait until a matching webhook lands" while a 13-file hand-written list reported clean.
  const paths = discoverSurfaces().map((s) => s.path);
  assert.ok(
    paths.includes("apps/docs/quickstart.mdx"),
    "quickstart mentions triggers but was not scanned",
  );
  assert.ok(paths.includes("README.md"));
});

test("discovery excludes the tests and fixtures that quote the lies on purpose", () => {
  for (const { path } of discoverSurfaces()) {
    assert.doesNotMatch(path, /\.test\./, `${path} is a test — it may legitimately quote a lie`);
    assert.doesNotMatch(path, /fixtures/, `${path} is a fixture`);
  }
});

test("every page carrying the positive obligation still exists", () => {
  const paths = new Set(discoverSurfaces().map((s) => s.path));
  for (const path of INTRODUCES) {
    assert.ok(
      paths.has(path),
      `${path} was renamed or no longer mentions triggers — update INTRODUCES`,
    );
  }
});

// --- catching the lie ---

test("catches every forbidden framing in one page", () => {
  const violations = scanSurfaces(fixture("lying.mdx"));
  // The fixture states each claim at least once; every pattern must fire on it. A pattern that never
  // fires is dead weight that reads as coverage.
  for (const { pattern } of FORBIDDEN_CLAIMS) {
    assert.ok(
      violations.some((v) => pattern.test(v.text)),
      `no violation matched ${pattern} — the pattern is dormant`,
    );
  }
});

test("a violation explains why the claim is false, not just that it matched", () => {
  const violations = scanSurfaces(fixture("lying.mdx"));
  for (const v of violations) assert.ok(v.why.length > 30, `unhelpful reason: ${v.why}`);
});

// --- NOT catching the truth (the half that decides whether authors trust the guard) ---

test("honest copy passes, including negated and capture-scoped phrasing", () => {
  // "captured the instant it arrives" is TRUE — capture is instantaneous, the agent wake is not.
  // "does NOT block until" is the correct clarification. A guard that fails these teaches authors to
  // delete the clarification, which is worse than the lie it was trying to prevent.
  assert.deepEqual(scanSurfaces(fixture("honest.mdx", true)), []);
});

// --- the positive obligation ---

test("copy that introduces triggers must state the mechanism", () => {
  const violations = scanSurfaces(fixture("vague.mdx", true));
  assert.equal(violations.length, 1);
  assert.match(violations[0].why, /never states the mechanism/);
});

test("the same vague copy is fine on a page that only mentions triggers in passing", () => {
  assert.deepEqual(scanSurfaces(fixture("vague.mdx", false)), []);
});

test("MECHANISM_WORDS accepts the vocabulary the honest pages actually use", () => {
  for (const word of ["short-poll", "short poll", "polls", "polling", "cadence", "cursor"]) {
    assert.match(word, MECHANISM_WORDS, `${word} should count as stating the mechanism`);
  }
  assert.doesNotMatch("woken when an event arrives", MECHANISM_WORDS);
});
