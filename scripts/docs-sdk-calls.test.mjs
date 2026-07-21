// Regression guard: the TypeScript snippets in the docs must name SDK methods that actually exist.
//
// Ten provider pages, the quickstart, and two guides all showed `webhook.providerSecrets.add(...)` or
// `webhook.endpoints.addProviderSecret(...)`. Neither is on the client — `providerSecrets` hangs off
// `endpoints` (`packages/sdk-ts/src/client.ts`), so a reader who pasted the snippet got
// `TypeError: Cannot read properties of undefined`. Docs code is API surface; a wrong call is a bug.
//
// Scope, stated honestly: this checks the two forms that actually shipped wrong, plus the real path's
// continued existence on the client. It is NOT a general "every dotted path in the docs resolves"
// check — that would need to walk the SDK's type surface. It stops THIS bug from coming back.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const DOCS = fileURLToPath(new URL("../apps/docs", import.meta.url));
const CLIENT = fileURLToPath(new URL("../packages/sdk-ts/src/client.ts", import.meta.url));

/** Every .mdx under apps/docs. */
function mdxFiles(dir = DOCS, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) mdxFiles(p, out);
    else if (name.endsWith(".mdx")) out.push(p);
  }
  return out;
}

// The forms that shipped wrong. `webhook.endpoints.addProviderSecret` is only wrong as an SDK CALL —
// the same string is the legitimate name of an MCP tool, so match the call parenthesis, not the name.
const WRONG = [
  { pattern: /\bwebhook\.providerSecrets\.add\(/, shown: "webhook.providerSecrets.add(" },
  {
    pattern: /\bwebhook\.endpoints\.addProviderSecret\(/,
    shown: "webhook.endpoints.addProviderSecret(",
  },
];

test("docs never call a provider-secrets method that is not on the SDK client", () => {
  const files = mdxFiles();
  assert.ok(files.length > 0, "zero-input floor: found no .mdx under apps/docs");

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { pattern, shown } of WRONG) {
      if (pattern.test(text)) offenders.push(`${file.replace(DOCS, "apps/docs")}: ${shown}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `docs call an SDK method that does not exist — use webhook.endpoints.providerSecrets.add(...):\n${offenders.join("\n")}`,
  );
});

test("the path the docs DO use still exists on the SDK client", () => {
  // Guards the other direction: if `providerSecrets` is ever moved off `endpoints`, the docs become
  // wrong again and this fails instead of the docs quietly rotting.
  const client = readFileSync(CLIENT, "utf8");
  assert.match(
    client,
    /class EndpointsResource\s*\{[\s\S]*?readonly providerSecrets: ProviderSecretsResource;/,
    "EndpointsResource no longer exposes `providerSecrets` — the docs' call path is stale",
  );
  assert.match(
    client,
    /class ProviderSecretsResource\s*\{[\s\S]*?\n {2}add\(/,
    "ProviderSecretsResource no longer has an `add` method",
  );
});
