import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { describe, expect, it } from "vitest";

/**
 * The verification showcase says "across 142 providers". That number is TRUE — and it is the only
 * kind of number this site is allowed to publish: one derived from something real.
 *
 * But a true number written as a literal is just a number that hasn't rotted yet. Add the 143rd
 * adapter and the homepage quietly starts lying, with nothing to notice. So the copy is pinned to the
 * registry it describes: add a provider, this test tells you which sentence to update.
 *
 * The import is TEST-ONLY (`@webhook-co/webhooks-spec` is a devDependency of apps/www). The marketing
 * site is a static export under a hard 600 KB byte budget — pulling the adapter registry into the
 * bundle to count it would cost far more than the number is worth.
 */
describe("the provider count on the homepage", () => {
  const showcases = readFileSync(join(__dirname, "showcases.tsx"), "utf8");

  it("matches the adapter registry it is describing", () => {
    const claimed = showcases.match(/across (\d+)\s*\n?\s*providers/);
    expect(claimed, "the 'across N providers' sentence moved — re-point this test").not.toBeNull();

    expect(
      Number(claimed?.[1]),
      `homepage says ${claimed?.[1]} providers, registry has ${PROVIDERS.length}`,
    ).toBe(PROVIDERS.length);
  });
});
