import { describe, expect, it } from "vitest";

import { newId } from "./ids";

describe("newId (uuidv7)", () => {
  it("returns a canonical v7 uuid", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("mints unique, time-ordered ids", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    // UUIDv7 is time-ordered, so a later id sorts lexicographically after an earlier one.
    expect([b, a].sort()).toEqual([a, b]);
  });
});
