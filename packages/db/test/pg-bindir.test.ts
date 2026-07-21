// The PostgreSQL binary resolution + version floor (#728). Pure unit tests — no cluster is started.
//
// This exists because bumping CI to `postgres:17` does NOT bump the local lane. The harness spawns
// `initdb`/`pg_ctl`/`createdb` by name, and Homebrew keeps every major side by side while LINKING
// only one — so a machine can have PG17 installed and still resolve `initdb` to PG14. Left
// unhandled, local would have quietly stayed on the old engine while CI moved, which is the exact
// divergence #728 exists to remove.
//
// The floor is load-bearing rather than tidy: the non-inheriting `webhook_owner` membership the
// provider model depends on is PG16+ semantics. On PG14/15 the provider inherits the owner and every
// denial in provider-fidelity.test.ts silently flips to ALLOWED — the suite would go green while
// proving the opposite of its claim.

import { describe, expect, it } from "vitest";

import { parsePgMajor, pickPgBinDir } from "./pg";

describe("parsePgMajor", () => {
  it("reads the major from real `initdb --version` output", () => {
    expect(parsePgMajor("initdb (PostgreSQL) 17.10 (Homebrew)")).toBe(17);
    expect(parsePgMajor("initdb (PostgreSQL) 14.23 (Homebrew)")).toBe(14);
    expect(parsePgMajor("initdb (PostgreSQL) 18.1")).toBe(18);
    expect(parsePgMajor("initdb (PostgreSQL) 17beta1")).toBe(17);
  });

  it("returns null rather than a wrong number when it cannot tell", () => {
    expect(parsePgMajor("")).toBeNull();
    expect(parsePgMajor("command not found")).toBeNull();
    expect(parsePgMajor("initdb 17.10")).toBeNull(); // no "(PostgreSQL)" marker
  });
});

describe("pickPgBinDir", () => {
  const majors: Record<string, number | null> = {
    "": 14, // whatever is on PATH
    "/opt/homebrew/opt/postgresql@17/bin": 17,
    "/nonexistent": null,
  };
  const majorOf = (dir: string) => majors[dir] ?? null;

  it("skips a too-old PATH install and finds a new-enough one", () => {
    expect(pickPgBinDir(["", "/opt/homebrew/opt/postgresql@17/bin"], majorOf, 17)).toBe(
      "/opt/homebrew/opt/postgresql@17/bin",
    );
  });

  it("prefers PATH when PATH is already new enough (no special-casing a correct machine)", () => {
    expect(pickPgBinDir(["", "/opt/homebrew/opt/postgresql@17/bin"], () => 17, 17)).toBe("");
  });

  it("returns null when nothing meets the floor — the harness must fail, not silently downgrade", () => {
    expect(pickPgBinDir(["", "/nonexistent"], majorOf, 17)).toBeNull();
  });

  it("accepts a NEWER major than the floor", () => {
    expect(pickPgBinDir(["/pg18"], () => 18, 17)).toBe("/pg18");
  });

  it("ignores candidates whose version cannot be determined", () => {
    expect(pickPgBinDir(["/nonexistent", "/pg17"], (d) => (d === "/pg17" ? 17 : null), 17)).toBe(
      "/pg17",
    );
  });

  it("returns null for an empty candidate list rather than defaulting to PATH", () => {
    expect(pickPgBinDir([], majorOf, 17)).toBeNull();
  });
});
