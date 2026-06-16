import { describe, expect, it } from "vitest";

import { readSecretBinding } from "./secrets";

describe("readSecretBinding", () => {
  it("returns a plain-string injection as-is (the local/test path)", async () => {
    expect(await readSecretBinding("plain-injected-value")).toBe("plain-injected-value");
  });

  it("calls .get() on a Secrets Store binding (the prod path)", async () => {
    let calls = 0;
    const binding: SecretsStoreSecret = {
      get: async () => {
        calls++;
        return "from-secrets-store";
      },
    };
    expect(await readSecretBinding(binding)).toBe("from-secrets-store");
    expect(calls).toBe(1);
  });
});
