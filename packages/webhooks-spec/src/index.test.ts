import { describe, expect, it } from "vitest";

import {
  ADAPTER_SCHEMES,
  STANDARD_WEBHOOKS_VERSION,
  detectScheme,
  getAdapterForScheme,
  githubAdapter,
  stripeAdapter,
} from "./index";

describe("public surface", () => {
  it("re-exports the version tag and the adapter entry points", () => {
    expect(STANDARD_WEBHOOKS_VERSION).toBe("v1");
    expect(stripeAdapter.scheme).toBe("stripe");
    expect(githubAdapter.scheme).toBe("github");
    expect(ADAPTER_SCHEMES).toContain("stripe");
    expect(getAdapterForScheme("stripe")).toBe(stripeAdapter);
    expect(detectScheme([["stripe-signature", "t=1,v1=x"]])).toBe("stripe");
  });
});
