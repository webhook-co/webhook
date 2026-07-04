import { describe, expect, it } from "vitest";

import { SDKS } from "./index.js";

describe("SDKS manifest", () => {
  it("lists all three official SDKs on distinct registries", () => {
    expect(SDKS).toHaveLength(3);
    expect(new Set(SDKS.map((s) => s.registry)).size).toBe(3);
    expect(new Set(SDKS.map((s) => s.language))).toEqual(new Set(["TypeScript", "Python", "Go"]));
  });

  it("every entry has a non-empty install command, package name, and webhook-co repository", () => {
    for (const sdk of SDKS) {
      expect(sdk.install.length).toBeGreaterThan(0);
      expect(sdk.packageName.length).toBeGreaterThan(0);
      expect(sdk.integrity.length).toBeGreaterThan(0);
      expect(sdk.repository).toMatch(/^https:\/\/github\.com\/webhook-co\//);
    }
  });
});
