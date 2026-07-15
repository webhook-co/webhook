import { describe, expect, it } from "vitest";

import { CAPABILITY_SCOPES, PROFILE_SCOPE, RESERVED_SCOPES } from "./capability";
import { describeScope } from "./scope-catalog";

describe("describeScope", () => {
  it("has a human title + description for every capability scope", () => {
    for (const scope of CAPABILITY_SCOPES) {
      const info = describeScope(scope);
      expect(info.scope).toBe(scope);
      expect(info.title).toBeTruthy();
      // The title must be human, not the raw machine scope — that's the whole point of the catalog.
      expect(info.title).not.toBe(scope);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });

  it("describes the reserved and identity scopes too (they appear on real grants)", () => {
    for (const scope of [...RESERVED_SCOPES, PROFILE_SCOPE]) {
      const info = describeScope(scope);
      expect(info.title).not.toBe(scope);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });

  it("marks the destructive delete scope as destructive (so a surface can flag it)", () => {
    expect(describeScope("events:delete").category).toBe("destructive");
  });

  it("shares identity for the profile scope, not a capability", () => {
    expect(describeScope(PROFILE_SCOPE).category).toBe("identity");
    expect(describeScope(PROFILE_SCOPE).description).toMatch(/name|email/i);
  });

  it("falls back to the raw name for an unknown scope — never hides it or claims it does nothing", () => {
    const info = describeScope("future:capability");
    // Show SOMETHING truthful: the raw scope as the title and a non-empty, non-misleading description.
    expect(info.title).toContain("future:capability");
    expect(info.description.length).toBeGreaterThan(0);
  });
});
