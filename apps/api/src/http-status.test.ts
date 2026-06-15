import { CAPABILITY_ERRORS } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { httpStatusForCapabilityError } from "./http-status.js";

describe("httpStatusForCapabilityError", () => {
  it("maps every capability error to a client/server status (total over the taxonomy)", () => {
    for (const code of CAPABILITY_ERRORS) {
      const status = httpStatusForCapabilityError(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it("uses the conventional status for each code", () => {
    expect(httpStatusForCapabilityError("NOT_FOUND")).toBe(404);
    expect(httpStatusForCapabilityError("UNAUTHORIZED")).toBe(401);
    expect(httpStatusForCapabilityError("FORBIDDEN")).toBe(403);
    expect(httpStatusForCapabilityError("VALIDATION_ERROR")).toBe(400);
    expect(httpStatusForCapabilityError("RATE_LIMITED")).toBe(429);
    expect(httpStatusForCapabilityError("ENDPOINT_PAUSED")).toBe(409);
    expect(httpStatusForCapabilityError("TARGET_UNREACHABLE")).toBe(502);
  });
});
