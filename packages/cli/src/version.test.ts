import { describe, expect, it } from "vitest";

import { resolveVersion, VERSION } from "./version.js";

describe("resolveVersion", () => {
  it("uses the build-time-stamped version when present", () => {
    expect(resolveVersion("0.3.0")).toBe("0.3.0");
    expect(resolveVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });

  it("falls back to 0.0.0 for an un-stamped (dev) build", () => {
    expect(resolveVersion(undefined)).toBe("0.0.0");
    expect(resolveVersion("")).toBe("0.0.0"); // empty define → treat as un-stamped
  });
});

describe("VERSION", () => {
  it("is 0.0.0 in a non-stamped build (tests/dev run with no --define)", () => {
    // The bundle injects WBHK_VERSION via `bun build --define`; under vitest it's undefined → 0.0.0,
    // which `doctor` renders as `0.0.0 (dev)`.
    expect(VERSION).toBe("0.0.0");
  });
});
