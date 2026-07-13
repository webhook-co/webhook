import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SDK_VERSION, userAgent } from "./version.js";

describe("SDK_VERSION", () => {
  // If the stamped version and package.json disagree, the User-Agent LIES about which version is running —
  // and the server's advisory then targets the wrong people (or nobody). The release stamps both; this
  // proves they stay in lockstep.
  it("matches package.json's version (a lying user-agent is worse than none)", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("builds a user-agent the server can parse: id/version (runtime)", () => {
    expect(userAgent("node/24; darwin")).toBe(`webhook-co-js/${SDK_VERSION} (node/24; darwin)`);
  });

  it("never throws while describing an unknown runtime", () => {
    expect(() => userAgent()).not.toThrow();
  });
});
