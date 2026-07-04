#!/usr/bin/env node
// Generate the SDK's typed core from the golden OpenAPI document. The types are DERIVED from
// packages/openapi/src/openapi.json (itself drift-guarded against the Zod contract), so the SDK can
// never silently diverge from the wire shape. The output is committed + drift-tested (see
// src/generated/schema.drift.test.ts) exactly like the golden spec, and prettier-ignored.
//
// Regenerate: pnpm --filter @webhook-co/sdk generate
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = join(here, "..", "..", "openapi", "src", "openapi.json");
export const OUT_PATH = join(here, "..", "src", "generated", "schema.d.ts");

export const HEADER =
  "// GENERATED FILE — DO NOT EDIT.\n" +
  "// Source: packages/openapi/src/openapi.json (the golden OpenAPI 3.1 document).\n" +
  "// Regenerate: pnpm --filter @webhook-co/sdk generate\n\n";

// Deterministic output (alphabetized) so the committed file + the drift test are stable across runs.
export const OPENAPI_TS_OPTIONS = { alphabetize: true };

/** Render the committed `.d.ts` contents from a parsed OpenAPI document — pure, so the drift test reuses it. */
export async function renderSchemaTypes(spec) {
  const ast = await openapiTS(spec, OPENAPI_TS_OPTIONS);
  return HEADER + astToString(ast);
}

export async function main() {
  const spec = JSON.parse(await readFile(SPEC_PATH, "utf8"));
  const contents = await renderSchemaTypes(spec);
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, contents);
  console.log(`✓ generated ${OUT_PATH}`);
}

// Run only when invoked directly (not when imported by the drift test).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
