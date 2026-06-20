import { describe, expect, it, vi } from "vitest";

import { introspectToken, type IntrospectDeps, type UnwrappedToken } from "./introspect-core";

// A2b-5 — the introspection core: maps a successful opaque-token unwrap to the RFC 7662-shaped result, and
// returns a bare {active:false} for anything the provider's unwrapToken rejects (unknown/invalid/expired).

const PRINCIPAL: UnwrappedToken = {
  orgId: "org_1",
  userId: "user_1",
  scopes: ["events:read", "events:replay"],
  audience: "https://mcp.webhook.co",
  expiresAt: 1_900_000_000,
};

function deps(over: Partial<IntrospectDeps> = {}): IntrospectDeps {
  return { unwrapToken: vi.fn(async () => PRINCIPAL), ...over };
}

describe("introspectToken", () => {
  it("maps a valid opaque token to its principal (active + attributes)", async () => {
    const res = await introspectToken(deps(), "opaque_xyz");
    expect(res).toEqual({
      active: true,
      orgId: "org_1",
      userId: "user_1",
      scopes: ["events:read", "events:replay"],
      audience: "https://mcp.webhook.co",
      expiresAt: 1_900_000_000,
    });
  });

  it("returns a bare {active:false} for an unknown/invalid/expired token (unwrap → null), no attributes", async () => {
    const res = await introspectToken(
      deps({ unwrapToken: vi.fn(async () => null) }),
      "opaque_dead",
    );
    expect(res).toEqual({ active: false });
  });

  it("returns {active:false} for an empty token without calling unwrap", async () => {
    const d = deps();
    expect(await introspectToken(d, "")).toEqual({ active: false });
    expect(d.unwrapToken).not.toHaveBeenCalled();
  });
});
