import { describe, expect, it } from "vitest";

import { DEFAULT_PROFILE } from "./config/schema.js";
import { InvalidProfileNameError } from "./errors.js";
import { resolveColorFlag, resolveGlobals, resolveProfile } from "./global-flags.js";

describe("resolveColorFlag", () => {
  it("--no-color (color=false) forces color off, even when the env says on", () => {
    expect(resolveColorFlag({ color: false }, true)).toBe(false);
  });

  it("--color (color=true) forces color on, even when not a TTY", () => {
    expect(resolveColorFlag({ color: true }, false)).toBe(true);
  });

  it("falls back to the env/TTY-resolved default when the flag is unset", () => {
    expect(resolveColorFlag({ color: undefined }, true)).toBe(true);
    expect(resolveColorFlag({}, false)).toBe(false);
  });
});

describe("resolveGlobals", () => {
  it("resolves the output format and the effective color (flag over context)", () => {
    expect(
      resolveGlobals({ colorEnabled: true }, { output: "json", apiUrl: undefined, color: false }),
    ).toEqual({ format: "json", color: false });
    expect(
      resolveGlobals({ colorEnabled: false }, { output: "text", apiUrl: undefined, color: true }),
    ).toEqual({ format: "text", color: true });
    expect(resolveGlobals({ colorEnabled: true }, { output: "text", apiUrl: undefined })).toEqual({
      format: "text",
      color: true,
    });
  });
});

describe("resolveProfile", () => {
  const ctxWith = (env: Record<string, string | undefined>, active?: string) => ({
    process: { env },
    store: { getActiveProfile: async () => active },
  });

  it("prefers --profile, then WBHK_PROFILE, then the persisted active profile, then the default", async () => {
    expect(
      await resolveProfile(ctxWith({ WBHK_PROFILE: "envp" }, "activep"), { profile: "flagp" }),
    ).toBe("flagp");
    expect(await resolveProfile(ctxWith({ WBHK_PROFILE: "envp" }, "activep"), {})).toBe("envp");
    expect(await resolveProfile(ctxWith({}, "activep"), {})).toBe("activep");
    expect(await resolveProfile(ctxWith({}, undefined), {})).toBe(DEFAULT_PROFILE);
  });

  it("ignores an empty --profile or WBHK_PROFILE (treats it as unset)", async () => {
    expect(await resolveProfile(ctxWith({ WBHK_PROFILE: "" }, undefined), { profile: "" })).toBe(
      DEFAULT_PROFILE,
    );
  });

  it("works when the store has no getActiveProfile (optional method)", async () => {
    expect(await resolveProfile({ process: { env: {} }, store: {} }, {})).toBe(DEFAULT_PROFILE);
  });

  it("rejects a reserved/unsafe profile name (prototype-pollution-prone object keys)", async () => {
    // `--profile __proto__` would otherwise make a `login` write silently no-op (a bracket-write hits
    // the prototype, not an own key) while still reporting success — fail loud instead, from any source.
    await expect(
      resolveProfile(ctxWith({}, undefined), { profile: "__proto__" }),
    ).rejects.toBeInstanceOf(InvalidProfileNameError);
    await expect(
      resolveProfile(ctxWith({ WBHK_PROFILE: "constructor" }, undefined), {}),
    ).rejects.toBeInstanceOf(InvalidProfileNameError);
    await expect(resolveProfile(ctxWith({}, "prototype"), {})).rejects.toBeInstanceOf(
      InvalidProfileNameError,
    );
  });
});
