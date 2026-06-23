import { describe, expect, it, vi } from "vitest";

import { redeemSessionExchange, type SessionExchangeCoreDeps } from "./session-exchange-core";

// The shared redeem core — consume the single-use ticket → read the profile → assemble the principal. Pure
// (consume + getProfile injected). Both the public HTTP route and the SessionExchange RPC redeem through here.

function deps(over: Partial<SessionExchangeCoreDeps> = {}): SessionExchangeCoreDeps {
  return {
    consume: async () => ({ userId: "user_dana", orgId: "org_dana" }),
    getProfile: async () => ({
      name: "Dana Doe",
      email: "dana@e.test",
      image: "https://img/d.png",
    }),
    ...over,
  };
}

describe("redeemSessionExchange", () => {
  it("consumes the ticket, reads the profile, and returns the principal (ok)", async () => {
    const result = await redeemSessionExchange(deps(), "sxt_x");
    expect(result).toEqual({
      status: "ok",
      principal: {
        orgId: "org_dana",
        userId: "user_dana",
        name: "Dana Doe",
        email: "dana@e.test",
        image: "https://img/d.png",
      },
    });
  });

  it("passes the ticket to consume and the resolved userId to getProfile", async () => {
    const consume = vi.fn(async () => ({ userId: "user_dana", orgId: "org_dana" }));
    const getProfile = vi.fn(async () => ({ name: "D", email: "d@e.test", image: null }));
    await redeemSessionExchange(deps({ consume, getProfile }), "sxt_abc");
    expect(consume).toHaveBeenCalledWith("sxt_abc");
    expect(getProfile).toHaveBeenCalledWith("user_dana");
  });

  it("returns invalid_grant when the ticket is unknown/expired/used (no profile read)", async () => {
    const getProfile = vi.fn(deps().getProfile);
    const result = await redeemSessionExchange(
      deps({ consume: async () => null, getProfile }),
      "sxt_x",
    );
    expect(result).toEqual({ status: "invalid_grant" });
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("returns user_missing when the consumed user no longer exists (ticket already burned)", async () => {
    const result = await redeemSessionExchange(deps({ getProfile: async () => null }), "sxt_x");
    expect(result).toEqual({ status: "user_missing" });
  });

  it("preserves a null avatar", async () => {
    const result = await redeemSessionExchange(
      deps({ getProfile: async () => ({ name: "D", email: "d@e.test", image: null }) }),
      "sxt_x",
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.principal.image).toBeNull();
  });
});
