import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  check,
  discoverSkills,
  isHyphenCase,
  isSemver,
  PLUGIN_DIR,
} from "./plugin-manifest-guard.mjs";

/**
 * These tests run the REAL guard over the REAL plugin on disk, then over fixtures that each break
 * exactly one rule. A manifest guard verified only against in-memory strings proves nothing about
 * whether it can find, open and parse the artifact it claims to cover.
 */

/** A manifest that passes every rule — each fixture below breaks exactly one thing. */
const OK = {
  name: "webhook-co",
  version: "0.1.0",
  description: "Diagnose why an inbound webhook signature is failing.",
  author: { name: "webhook.co", url: "https://www.webhook.co" },
  homepage: "https://www.webhook.co",
  repository: "https://github.com/webhook-co/webhook",
  license: "Apache-2.0",
  keywords: ["webhook"],
  skills: "./skills/",
  interface: {
    displayName: "webhook.co",
    shortDescription: "Debug webhook signatures",
    longDescription: "Work out why an inbound webhook signature will not verify.",
    developerName: "webhook.co",
    category: "Developer Tools",
    capabilities: ["Interactive"],
    websiteURL: "https://www.webhook.co",
    privacyPolicyURL: "https://www.webhook.co/privacy",
    termsOfServiceURL: "https://www.webhook.co/terms",
    defaultPrompt: ["My webhook signature check is failing"],
    brandColor: "#0e141b",
    composerIcon: "./assets/mark.svg",
    logo: "./assets/logo.png",
  },
};

/** The sources `check()` reads, as content — so a fixture never touches the real plugin. */
function sources(overrides = {}) {
  return {
    manifestSource: JSON.stringify(OK),
    dirName: "webhook-co",
    skills: [{ dir: "debug-webhook-signature", name: "debug-webhook-signature", description: "d" }],
    assetPaths: ["./assets/mark.svg", "./assets/logo.png"],
    ...overrides,
  };
}
const withManifest = (patch) => sources({ manifestSource: JSON.stringify({ ...OK, ...patch }) });
const withInterface = (patch) =>
  sources({
    manifestSource: JSON.stringify({ ...OK, interface: { ...OK.interface, ...patch } }),
  });

// ---------------------------------------------------------------- floor: the real thing passes

test("the actual plugin in this repo passes the guard", () => {
  assert.deepEqual(check(), []);
});

test("the real plugin directory really contains at least one skill", () => {
  // Floor for the skill rules: if discovery silently found nothing, every per-skill rule below
  // would pass over an empty set and this guard would certify an empty plugin.
  assert.ok(discoverSkills().length >= 1);
});

// ---------------------------------------------------------------- zero-input floors

test("an unreadable manifest fails instead of passing vacuously", () => {
  const problems = check(sources({ manifestSource: null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot read/i);
});

test("an unparseable manifest fails with a parse error, not a crash", () => {
  const problems = check(sources({ manifestSource: "{ not json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not parse/i);
});

test("a plugin with no skills at all fails — a skills-only plugin must ship a skill", () => {
  const problems = check(sources({ skills: [] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no skills/i);
});

// ---------------------------------------------------------------- skills-only invariants

test("declaring an MCP server fails: a skills-only submission must not carry one", () => {
  const problems = check(withManifest({ mcpServers: "./.mcp.json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mcpServers/);
});

test("declaring apps fails for the same reason", () => {
  const problems = check(withManifest({ apps: "./.app.json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps/);
});

test("declaring hooks fails", () => {
  const problems = check(withManifest({ hooks: "./hooks/hooks.json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /hooks/);
});

test("a non-empty screenshots array fails", () => {
  const problems = check(withInterface({ screenshots: ["./assets/one.png"] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /screenshots/);
});

test("an EMPTY screenshots array is accepted — it is absence of content, not a declaration", () => {
  assert.deepEqual(check(withInterface({ screenshots: [] })), []);
});

// ---------------------------------------------------------------- identity

test("a manifest name that differs from its directory fails", () => {
  const problems = check(withManifest({ name: "something-else" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /directory/i);
});

test("a name that is not lowercase-hyphen fails", () => {
  const problems = check(
    sources({
      manifestSource: JSON.stringify({ ...OK, name: "Webhook_Co" }),
      dirName: "Webhook_Co",
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lowercase/i);
});

test("a non-semver version fails", () => {
  const problems = check(withManifest({ version: "0.1" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /semver/i);
});

test("isHyphenCase rejects the shapes a nested-quantifier regex would have to backtrack on", () => {
  for (const good of ["webhook-co", "webhook", "a1-b2-c3"]) {
    assert.equal(isHyphenCase(good), true, `should accept ${good}`);
  }
  // Leading/trailing/doubled separators produce an empty segment, which is the whole point of
  // splitting rather than pattern-matching: each is a linear check, not a backtracking one.
  for (const bad of ["Webhook_Co", "-lead", "trail-", "a--b", "", "has space"]) {
    assert.equal(isHyphenCase(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("isSemver accepts prerelease and build metadata, rejects the near-misses", () => {
  for (const good of ["0.1.0", "1.0.0-beta.1", "1.2.3+codex.local"]) {
    assert.equal(isSemver(good), true, `should accept ${good}`);
  }
  for (const bad of ["0.1", "v1.0.0", "1.0.0.0", ""]) {
    assert.equal(isSemver(bad), false, `should reject ${bad}`);
  }
});

// ---------------------------------------------------------------- the length traps

test("a displayName over the FINAL-SUBMISSION cap fails, even though package validation allows 80", () => {
  const problems = check(withInterface({ displayName: "x".repeat(31) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /displayName/);
});

test("a displayName exactly at the cap passes", () => {
  assert.deepEqual(check(withInterface({ displayName: "x".repeat(30) })), []);
});

test("a shortDescription over the final-submission cap fails", () => {
  const problems = check(withInterface({ shortDescription: "x".repeat(31) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /shortDescription/);
});

test("a shortDescription exactly at the cap passes", () => {
  assert.deepEqual(check(withInterface({ shortDescription: "x".repeat(30) })), []);
});

test("a defaultPrompt entry over 128 chars fails", () => {
  const problems = check(withInterface({ defaultPrompt: ["x".repeat(129)] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /defaultPrompt/);
});

test("more than three defaultPrompt entries fails", () => {
  const problems = check(withInterface({ defaultPrompt: ["a", "b", "c", "d"] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /defaultPrompt/);
});

// ---------------------------------------------------------------- required interface fields

test("every interface field OpenAI's evaluator treats as an error is required here too", () => {
  const required = [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "capabilities",
    "websiteURL",
    "privacyPolicyURL",
    "termsOfServiceURL",
    "defaultPrompt",
  ];
  for (const field of required) {
    const iface = { ...OK.interface };
    delete iface[field];
    const problems = check(
      sources({ manifestSource: JSON.stringify({ ...OK, interface: iface }) }),
    );
    assert.equal(problems.length, 1, `dropping ${field} should be exactly one problem`);
    assert.ok(problems[0].includes(field), `the message should name ${field}: ${problems[0]}`);
  }
});

test("a required interface field that is present but EMPTY fails like a missing one", () => {
  // Checking only for `undefined` would let a blank displayName or an empty capabilities array
  // through — present, therefore "supplied", and rejected at submission for being blank.
  for (const [field, empty] of [
    ["displayName", ""],
    ["shortDescription", "   "],
    ["capabilities", []],
    ["defaultPrompt", []],
  ]) {
    const problems = check(withInterface({ [field]: empty }));
    assert.equal(problems.length, 1, `empty ${field} should be exactly one problem`);
    assert.ok(problems[0].includes(field), `the message should name ${field}: ${problems[0]}`);
  }
});

test("a category outside OpenAI's closed enum fails", () => {
  const problems = check(withInterface({ category: "Webhooks" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /category/);
});

// ---------------------------------------------------------------- assets and skills

test("an interface asset that is not on disk fails", () => {
  const problems = check(sources({ assetPaths: ["./assets/mark.svg"] })); // logo.png missing
  assert.equal(problems.length, 1);
  assert.match(problems[0], /logo/);
});

test("a skill whose frontmatter name differs from its directory fails", () => {
  const problems = check(
    sources({ skills: [{ dir: "debug-webhook-signature", name: "other", description: "d" }] }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /directory/i);
});

test("a skill with no description fails", () => {
  const problems = check(
    sources({
      skills: [
        { dir: "debug-webhook-signature", name: "debug-webhook-signature", description: "" },
      ],
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /description/i);
});

test("a combined plugin:skill identifier over 64 chars fails", () => {
  const long = "d".repeat(60);
  const problems = check(sources({ skills: [{ dir: long, name: long, description: "d" }] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /64/);
});

// ---------------------------------------------------------------- accumulation

test("three simultaneous defects are all reported, not just the first", () => {
  const problems = check(
    sources({
      manifestSource: JSON.stringify({
        ...OK,
        version: "0.1",
        mcpServers: "./.mcp.json",
        interface: { ...OK.interface, displayName: "x".repeat(31) },
      }),
    }),
  );
  assert.equal(problems.length, 3);
});

test("PLUGIN_DIR points at the real plugin, and discovery reads its skills from disk", () => {
  assert.ok(existsSync(join(PLUGIN_DIR, ".codex-plugin", "plugin.json")));
  // Discovery walks `skills/`, so pointing it at the plugin root must find nothing — this proves the
  // floor above is reading the right tree and not accidentally succeeding on any directory.
  assert.deepEqual(discoverSkills(PLUGIN_DIR), []);
  assert.ok(discoverSkills(join(PLUGIN_DIR, "skills")).length >= 1);
});
