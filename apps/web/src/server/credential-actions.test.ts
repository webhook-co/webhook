import { describe, expect, it, vi } from "vitest";

// The action gates on the session; stub it so the unit runs without a cookie.
vi.mock("./session", () => ({
  verifySession: vi.fn(async () => ({
    userId: "u",
    orgId: "o",
    user: { name: "", email: "", image: null },
  })),
}));

import { createApiKey } from "./credential-actions";

describe("createApiKey (mock)", () => {
  it("rejects an empty name", async () => {
    expect((await createApiKey({ name: "   ", scopes: ["events:read"] })).ok).toBe(false);
  });

  it("rejects when no grantable scope is chosen", async () => {
    expect((await createApiKey({ name: "k", scopes: [] })).ok).toBe(false);
  });

  it("narrows scopes to the grantable set — drops reserved/unknown scopes", async () => {
    const result = await createApiKey({
      name: "k",
      scopes: ["events:read", "keys:manage", "totally:bogus"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key.scopes).toEqual(["events:read"]);
      expect(result.key.scopes).not.toContain("keys:manage");
    }
  });

  it("returns a one-time plaintext distinct from the redacted start", async () => {
    const result = await createApiKey({ name: "CI deploy", scopes: ["events:read"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plaintext).toMatch(/^whsec_/);
      expect(result.key.start).toContain("…");
      expect(result.key.start).not.toBe(result.plaintext);
      expect(result.key.name).toBe("CI deploy");
    }
  });
});
