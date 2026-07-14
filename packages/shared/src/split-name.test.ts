import { describe, expect, it } from "vitest";

import { splitName } from "./split-name";
// The single canonical name-splitter (was duplicated in apps/auth + apps/web before this consolidation).

// GitHub gives a single `name`; this splits it into a first/last GUESS that onboarding lets the user correct.
// It only has to be reasonable, not right — but it must never THROW or duplicate, because a signup runs it.
describe("splitName", () => {
  it("splits a two-part name", () => {
    expect(splitName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("keeps everything after the first token as the surname", () => {
    expect(splitName("Ada King van der Berg")).toEqual({
      firstName: "Ada",
      lastName: "King van der Berg",
    });
  });

  it("leaves the last name empty for a single token — never duplicates it", () => {
    expect(splitName("Prince")).toEqual({ firstName: "Prince", lastName: undefined });
  });

  it("is empty for an empty, whitespace, or missing name", () => {
    for (const input of ["", "   ", null, undefined]) {
      expect(splitName(input)).toEqual({ firstName: undefined, lastName: undefined });
    }
  });

  it("collapses odd whitespace rather than producing blank tokens", () => {
    expect(splitName("  Ada   Lovelace  ")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });
});
