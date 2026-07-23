import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { REGISTRY_DESCRIPTION_MAX, check, documentedRemoteUrls } from "./mcp-registry-guard.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A manifest that passes every rule — each fixture below breaks exactly one thing. */
const OK = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "co.webhook/webhook",
  title: "webhook.co",
  description: "Receive, inspect, replay and deliver webhooks.",
  version: "1.0.0",
  websiteUrl: "https://docs.webhook.co/mcp/overview",
  repository: { url: "https://github.com/webhook-co/webhook", source: "github" },
  remotes: [{ type: "streamable-http", url: "https://mcp.webhook.co/mcp" }],
};

/** The sources `check()` reads, as content — so a fixture never touches the real repo. */
function sources(overrides = {}) {
  return {
    serverJsonSource: JSON.stringify(OK),
    docsSources: ["Point your client at https://mcp.webhook.co/mcp to connect."],
    agentSource: 'const SERVER_VERSION = "1.0.0";',
    ...overrides,
  };
}

const withManifest = (patch) => sources({ serverJsonSource: JSON.stringify({ ...OK, ...patch }) });

// ---------------------------------------------------------------------------
// The floor: the invariant proven against the REAL repository. If this passes
// vacuously (missing file, unreadable docs) the tests below prove it cannot —
// every read failure is a problem, never a silent skip.
// ---------------------------------------------------------------------------

test("the actual repository passes the guard", () => {
  assert.deepEqual(check(), []);
});

test("the real manifest is the one the real server advertises", () => {
  const manifest = JSON.parse(readFileSync(join(REPO, "apps", "mcp", "server.json"), "utf8"));
  const agent = readFileSync(join(REPO, "apps", "mcp", "src", "mcp-agent.ts"), "utf8");
  const declaration = `SERVER_VERSION = "${manifest.version}"`;
  assert.ok(agent.includes(declaration), `mcp-agent.ts does not declare ${declaration}`);
  // Publishing is authorised by DNS on the webhook.co apex, so the namespace is
  // not a style choice — a different prefix cannot be published at all.
  assert.ok(manifest.name.startsWith("co.webhook/"), `name was ${manifest.name}`);
});

test("the real docs actually document a remote URL", () => {
  // Floor for the docs-parity rule below: if the extractor silently found
  // nothing, the parity check would pass over an empty set.
  assert.ok(documentedRemoteUrls().length >= 1);
});

// ---------------------------------------------------------------------------
// Zero-input floors — an unreadable input must FAIL, not pass over nothing.
// ---------------------------------------------------------------------------

test("a missing server.json fails instead of passing vacuously", () => {
  const problems = check(sources({ serverJsonSource: null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot read/i);
});

test("an unparseable server.json fails", () => {
  const problems = check(sources({ serverJsonSource: "{ not json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /parse/i);
});

test("docs that document no remote URL fail", () => {
  const problems = check(sources({ docsSources: ["nothing to see here"] }));
  assert.match(problems.join("\n"), /no remote URL/i);
});

// ---------------------------------------------------------------------------
// The publish-blocking rules. Each of these is a real registry rejection.
// ---------------------------------------------------------------------------

test("flags a description over the registry's 100-character cap", () => {
  // The exact defect this guard was written for: the in-code SERVER_DESCRIPTION
  // was 109 chars, which the registry silently rejects at publish time.
  const problems = check(withManifest({ description: "x".repeat(REGISTRY_DESCRIPTION_MAX + 1) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /description/);
  assert.match(problems[0], /100/);
});

test("accepts a description exactly at the cap", () => {
  assert.deepEqual(check(withManifest({ description: "x".repeat(REGISTRY_DESCRIPTION_MAX) })), []);
});

test("flags a namespace we cannot authenticate for", () => {
  const problems = check(withManifest({ name: "io.github.webhook-co/webhook" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /co\.webhook\//);
});

test("flags a name that breaks the registry's name pattern", () => {
  const problems = check(withManifest({ name: "co.webhook/web hook" }));
  assert.match(problems.join("\n"), /pattern/i);
});

test("flags a remote URL the docs do not document", () => {
  // The drift that matters: the registry sends every client to a URL our own
  // docs never mention, so the listing and the product disagree.
  const problems = check(
    withManifest({ remotes: [{ type: "streamable-http", url: "https://mcp.webhook.co/v2" }] }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs/i);
});

test("flags a version that disagrees with the server's advertised version", () => {
  const problems = check(sources({ agentSource: 'const SERVER_VERSION = "0.0.0";' }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0\.0\.0/);
});

test("flags a version that is not semver", () => {
  const problems = check({
    ...withManifest({ version: "v1" }),
    agentSource: 'const SERVER_VERSION = "v1";',
  });
  assert.match(problems.join("\n"), /semver/i);
});

test("flags a non-https or redirecting website URL", () => {
  const problems = check(withManifest({ websiteUrl: "http://docs.webhook.co/mcp/overview" }));
  assert.match(problems.join("\n"), /https/i);
});

test("flags an apex URL that is known to redirect", () => {
  // https://webhook.co/* 301s to www. The registry's well-known fetcher
  // disables redirects, and clients following an icon get an HTML page.
  const problems = check(
    withManifest({ icons: [{ src: "https://webhook.co/logo.png", mimeType: "image/png" }] }),
  );
  assert.match(problems.join("\n"), /redirect/i);
});

test("flags a schema URL that is not the official one", () => {
  const problems = check(withManifest({ $schema: "https://example.com/server.schema.json" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /schema/i);
});

test("flags a header that would ask a client for a secret", () => {
  // We authenticate with OAuth; a manifest asking clients to paste a token into
  // a header would teach every listing the wrong, less safe flow.
  const problems = check(
    withManifest({
      remotes: [
        {
          type: "streamable-http",
          url: "https://mcp.webhook.co/mcp",
          headers: [{ name: "Authorization", isSecret: true, isRequired: true }],
        },
      ],
    }),
  );
  assert.match(problems.join("\n"), /secret|header/i);
});

test("flags anything that looks like a credential in the manifest", () => {
  const problems = check(withManifest({ title: "webhook.co whk_livekey000000000000" }));
  assert.match(problems.join("\n"), /credential/i);
});

test("flags a competitor name in the manifest", () => {
  // Public-repo content hygiene: competitor names are permitted in apps/www
  // marketing content only, and a registry manifest is not that.
  const problems = check(withManifest({ description: "A better ngrok for webhooks." }));
  assert.match(problems.join("\n"), /competitor/i);
});

test("reports every problem at once rather than stopping at the first", () => {
  const problems = check(
    withManifest({ name: "io.github.x/y", description: "z".repeat(200), title: "" }),
  );
  assert.ok(problems.length >= 3, `expected >= 3 problems, got ${problems.length}`);
});
