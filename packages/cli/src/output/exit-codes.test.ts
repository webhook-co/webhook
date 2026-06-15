import { ExitCode } from "@stricli/core";
import { CAPABILITY_ERRORS } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_EXIT,
  EXIT,
  exitCodeForCapabilityError,
  normalizeStricliExitCode,
} from "./exit-codes.js";

describe("exit-codes", () => {
  it("maps every capability error to a stable, distinct, non-zero code", () => {
    const codes = CAPABILITY_ERRORS.map((e) => exitCodeForCapabilityError(e));
    // total over the closed taxonomy
    for (const e of CAPABILITY_ERRORS) {
      expect(typeof CAPABILITY_EXIT[e]).toBe("number");
      expect(CAPABILITY_EXIT[e]).toBeGreaterThan(0);
    }
    // distinct — scripts can branch on the specific failure
    expect(new Set(codes).size).toBe(CAPABILITY_ERRORS.length);
    // and never collides with the reserved generic codes
    expect(codes).not.toContain(EXIT.SUCCESS);
    expect(codes).not.toContain(EXIT.USAGE);
  });

  it("reserves stable generic codes", () => {
    expect(EXIT.SUCCESS).toBe(0);
    expect(EXIT.UNEXPECTED).toBe(1);
    expect(EXIT.USAGE).toBe(2);
  });

  it("normalizes stricli's internal (negative) exit codes to POSIX-friendly codes", () => {
    // routing / parse failures → usage error (2)
    expect(normalizeStricliExitCode(ExitCode.UnknownCommand)).toBe(EXIT.USAGE);
    expect(normalizeStricliExitCode(ExitCode.InvalidArgument)).toBe(EXIT.USAGE);
    // library/internal faults → generic failure (1)
    expect(normalizeStricliExitCode(ExitCode.ContextLoadError)).toBe(EXIT.UNEXPECTED);
    expect(normalizeStricliExitCode(ExitCode.CommandLoadError)).toBe(EXIT.UNEXPECTED);
    expect(normalizeStricliExitCode(ExitCode.InternalError)).toBe(EXIT.UNEXPECTED);
    // success + already-positive command codes pass through unchanged
    expect(normalizeStricliExitCode(ExitCode.Success)).toBe(0);
    expect(normalizeStricliExitCode(ExitCode.CommandRunError)).toBe(1);
    expect(normalizeStricliExitCode(7)).toBe(7);
    // absent / null → success
    expect(normalizeStricliExitCode(undefined)).toBe(0);
    expect(normalizeStricliExitCode(null)).toBe(0);
    // an unexpected string exit code → generic failure
    expect(normalizeStricliExitCode("oops")).toBe(EXIT.UNEXPECTED);
    // every code stays inside the POSIX 0–255 range
    for (const raw of Object.values(ExitCode)) {
      const code = normalizeStricliExitCode(raw);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThanOrEqual(255);
    }
  });
});
