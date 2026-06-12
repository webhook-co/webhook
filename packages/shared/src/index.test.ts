import { describe, expect, it } from "vitest";

import { redactSecret, SERVICE_NAME } from "./index.js";

describe("@webhook-co/shared barrel", () => {
  it("identifies the service", () => {
    expect(SERVICE_NAME).toBe("webhook");
  });

  it("re-exports helpers from submodules (e.g. redactSecret)", () => {
    expect(redactSecret("whsec_abcdef")).toBe("whse****");
  });
});
