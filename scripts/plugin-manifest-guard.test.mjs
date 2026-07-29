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
  mcpServers: "./.mcp.json",
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
    mcpSource: JSON.stringify({
      mcpServers: {
        webhook: {
          type: "http",
          url: "https://mcp.webhook.co/mcp",
          oauth_resource: "https://mcp.webhook.co",
        },
      },
    }),
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

test("a plugin with no skills fails, even though it also ships an MCP server", () => {
  // The MCP server alone would be a non-empty runtime surface, so nothing external forces a skill here.
  // We require one anyway: it is the only part that works without an account, and dropping it would turn
  // the listing into pure OAuth-gated surface without anyone noticing.
  const problems = check(sources({ skills: [] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no skills/i);
});

// ------------------------------------------------- MCP-backed invariants (ADR-0132 supersedes ADR-0131)
//
// This plugin was skills-only and is now skills + MCP. The old guard asserted the OPPOSITE — that
// `mcpServers` must be absent — on the strength of a claimed `mcp_configuration_excluded` rejection. That
// claim was FALSE: 8 of the 180 curated plugins (github, linear, notion, figma, cloudflare and OpenAI's own
// openai-developers among them) ship skills AND mcpServers, and the string appears nowhere in the shipped
// validator or spec. The spec's own sample manifest carries skills, hooks, mcpServers and apps together.

test("a manifest with NO mcpServers fails — this is an MCP-backed submission", () => {
  const { mcpServers, ...withoutMcp } = OK;
  assert.ok(mcpServers !== undefined, "fixture must have had mcpServers to remove");
  const problems = check(sources({ manifestSource: JSON.stringify(withoutMcp) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mcpServers/);
});

test("mcpServers pointing somewhere other than ./.mcp.json fails", () => {
  // The guard validates the contents of ./.mcp.json. Repointing the field would leave that file
  // validated but unused, and the real config unvalidated, while the guard still printed OK.
  const problems = check(withManifest({ mcpServers: "./somewhere-else.json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\.mcp\.json/);
});

test("an unparseable .mcp.json fails rather than being skipped", () => {
  const problems = check(sources({ mcpSource: "{not json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not parse/i);
});

test("a missing .mcp.json fails — never a pass over an absent file", () => {
  const problems = check(sources({ mcpSource: null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot read|missing/i);
});

test("a stdio/local MCP server is rejected — a published plugin must not run a local process", () => {
  const problems = check(
    sources({
      mcpSource: JSON.stringify({
        mcpServers: { webhook: { command: "npx", args: ["-y", "@webhook-co/mcp"] } },
      }),
    }),
  );
  assert.ok(problems.length >= 1);
  assert.match(problems.join("\n"), /http|command/i);
});

test("the MCP url must be our real endpoint, not a placeholder or another host", () => {
  for (const url of [
    "https://mcp.example.com/mcp",
    "http://mcp.webhook.co/mcp", // plaintext
    "https://mcp.webhook.co/sse", // /sse is a 404 on our server — streamable-http only
  ]) {
    const problems = check(
      sources({
        mcpSource: JSON.stringify({
          mcpServers: { webhook: { type: "http", url, oauth_resource: "https://mcp.webhook.co" } },
        }),
      }),
    );
    assert.ok(problems.length >= 1, `expected ${url} to be rejected`);
  }
});

test("oauth_resource must equal the PRM `resource`, or the OAuth audience silently mismatches", () => {
  // Our live PRM declares resource = "https://mcp.webhook.co". RFC 8707 binds the token to that exact
  // audience, so an oauth_resource of ".../mcp" sends clients to request the wrong audience.
  const problems = check(
    sources({
      mcpSource: JSON.stringify({
        mcpServers: {
          webhook: {
            type: "http",
            url: "https://mcp.webhook.co/mcp",
            oauth_resource: "https://mcp.webhook.co/mcp",
          },
        },
      }),
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /oauth_resource/);
});

test("a .mcp.json carrying `headers` fails — a published config must embed no credential", () => {
  // This is where a static `Authorization: Bearer …` would live in an MCP client config. The file ships to
  // every installer, so a credential here is a credential published to strangers. Our server uses OAuth;
  // there is no legitimate reason for this plugin's config to carry headers at all.
  const problems = check(
    sources({
      mcpSource: JSON.stringify({
        mcpServers: {
          webhook: {
            type: "http",
            url: "https://mcp.webhook.co/mcp",
            oauth_resource: "https://mcp.webhook.co",
            headers: { Authorization: "Bearer not-a-real-token" }, // gitleaks:allow
          },
        },
      }),
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /headers/);
  // The problem message must NOT echo the credential it is complaining about.
  assert.ok(
    !problems[0].includes("not-a-real-token"),
    "the guard must not echo the credential into a message that gets logged",
  );
});

test("no problem message echoes a value read out of .mcp.json", () => {
  // js/clear-text-logging (HIGH) fired on exactly this shape: a field read from .mcp.json interpolated
  // into a message that reaches console.error. Today those values are public URLs, but the SHAPE is the
  // finding, and `headers` proves the file can hold a real secret. So messages name the EXPECTED constant
  // and the offending field, never the found value.
  const secretish = "https://evil.example/leaked-abc123";
  const problems = check(
    sources({
      mcpSource: JSON.stringify({
        mcpServers: {
          webhook: { type: "http", url: secretish, oauth_resource: secretish },
        },
      }),
    }),
  );
  assert.ok(problems.length >= 1, "expected the bad config to be rejected");
  for (const p of problems) {
    assert.ok(!p.includes(secretish), `message echoed a value read from .mcp.json: ${p}`);
  }
});

test("declaring more than one MCP server fails — the listing is one server", () => {
  const problems = check(
    sources({
      mcpSource: JSON.stringify({
        mcpServers: {
          webhook: {
            type: "http",
            url: "https://mcp.webhook.co/mcp",
            oauth_resource: "https://mcp.webhook.co",
          },
          other: {
            type: "http",
            url: "https://mcp.webhook.co/mcp",
            oauth_resource: "https://mcp.webhook.co",
          },
        },
      }),
    }),
  );
  assert.ok(problems.length >= 1);
});

test("declaring apps still fails — we ship no ChatGPT Apps SDK custom UI", () => {
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

test("a manifest whose `skills` field is repointed or dropped fails", () => {
  // The guard walks a fixed directory, so without this rule repointing `skills` (or deleting it)
  // would ship a tree nothing validated while the guard still printed OK.
  for (const patch of [{ skills: "./skills-v2/" }, { skills: undefined }]) {
    const problems = check(withManifest(patch));
    assert.equal(problems.length, 1, `${JSON.stringify(patch)} should be exactly one problem`);
    assert.match(problems[0], /skills/);
  }
});

test("a defaultPrompt that is a bare string fails instead of skipping both caps", () => {
  const problems = check(withInterface({ defaultPrompt: "a single string, not an array" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /defaultPrompt must be an array/);
});

test("an asset path that escapes the plugin directory fails", () => {
  const problems = check(
    sources({
      manifestSource: JSON.stringify({
        ...OK,
        interface: { ...OK.interface, logo: "../../package.json" },
      }),
      assetPaths: ["./assets/mark.svg", "../../package.json"],
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /escapes/);
});

// ---------------------------------------------------------------- accumulation

test("three simultaneous defects are all reported, not just the first", () => {
  const problems = check(
    sources({
      manifestSource: JSON.stringify({
        ...OK,
        version: "0.1",
        // `apps`, not `mcpServers`: since ADR-0132 an mcpServers reference is REQUIRED, so using it here
        // would leave this fixture with two defects and the count assertion would pass for the wrong reason.
        apps: "./.app.json",
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
