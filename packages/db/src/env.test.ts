import { describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "./env";

describe("resolveDatabaseUrl", () => {
  it("returns DATABASE_URL when set", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://x/y" })).toBe("postgres://x/y");
  });

  it("throws a helpful error when unset", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL is not set/);
  });

  it("treats a blank value as unset", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL is not set/);
  });
});
