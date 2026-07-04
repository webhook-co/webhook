// The paths read here are fixed module constants from the generator, not user input.
/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OUT_PATH, SPEC_PATH, renderSchemaTypes } from "../../scripts/generate-types.mjs";

// Drift guard for the generated typed core. The committed `schema.d.ts` MUST equal a fresh render of
// the golden OpenAPI document — so a spec change that isn't regenerated (`pnpm --filter @webhook-co/sdk
// generate`) fails CI instead of shipping an SDK whose types silently disagree with the wire contract.
describe("generated schema types", () => {
  it("are in sync with the golden OpenAPI spec", async () => {
    const spec = JSON.parse(await readFile(SPEC_PATH, "utf8"));
    const expected = await renderSchemaTypes(spec);
    const actual = await readFile(OUT_PATH, "utf8");
    expect(actual).toBe(expected);
  });
});
