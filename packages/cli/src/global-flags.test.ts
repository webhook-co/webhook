import { describe, expect, it } from "vitest";

import { resolveColorFlag, resolveGlobals } from "./global-flags.js";

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
