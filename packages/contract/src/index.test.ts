import { describe, expect, it } from "vitest";

import { CONTRACT_PACKAGE } from "./index";

// Smoke test only. The real capability-registry + parity-conformance tests
// land in the capability-contract step.
describe("@webhook-co/contract", () => {
  it("exposes its package name", () => {
    expect(CONTRACT_PACKAGE).toBe("@webhook-co/contract");
  });
});
