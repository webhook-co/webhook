import { describe, expect, it, vi } from "vitest";

import { redeemDeviceCode, type DeviceTokenDeps, DEVICE_GRANT_TYPE } from "./device-token-core";

// A4b — the device-code grant FSM: each non-approved poll state maps to its RFC 8628 §3.5 response, and an
// approved code mints (+ a refresh handle) with audience/scope defense-in-depth + rollback on refresh failure.

const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";
const CAPABILITY = ["events:read", "events:replay", "endpoints:read"];

const APPROVED_PROPS = {
  orgId: "org_1",
  userId: "user_dana",
  scopes: ["events:read", "events:replay"],
  audience: API,
  device: { name: "Dana's laptop" },
};

function deps(over: Partial<DeviceTokenDeps> = {}): DeviceTokenDeps {
  return {
    allowedAudiences: [API, MCP],
    allowedScopes: CAPABILITY,
    keyTtlSeconds: 86_400,
    defaultPendingInterval: 5,
    poll: async () => ({ kind: "approved", props: APPROVED_PROPS }),
    mintScopedKey: async () => ({
      status: "minted",
      grantId: "grant_1",
      plaintext: "whk_" + "x".repeat(40),
      keyId: "key_1",
      expiresAt: new Date(0),
    }),
    issueRefreshToken: async () => "rtk_" + "y".repeat(40),
    rollbackMint: vi.fn(async () => {}),
    ...over,
  };
}

const REQ = {
  grant_type: DEVICE_GRANT_TYPE,
  device_code: "dev_code",
  client_id: "cli_wbhk",
} as const;

describe("redeemDeviceCode — poll FSM → RFC 8628 §3.5", () => {
  it("maps pending → authorization_pending", async () => {
    const r = await redeemDeviceCode(deps({ poll: async () => ({ kind: "pending" }) }), REQ);
    expect(r).toEqual({ kind: "error", error: "authorization_pending" });
  });
  it("maps slow_down → slow_down", async () => {
    const r = await redeemDeviceCode(deps({ poll: async () => ({ kind: "slow_down" }) }), REQ);
    expect(r).toEqual({ kind: "error", error: "slow_down" });
  });
  it("maps denied → access_denied", async () => {
    const r = await redeemDeviceCode(deps({ poll: async () => ({ kind: "denied" }) }), REQ);
    expect(r.kind).toBe("error");
    expect((r as { error: string }).error).toBe("access_denied");
  });
  it("maps invalid (unknown/expired) → expired_token", async () => {
    const r = await redeemDeviceCode(deps({ poll: async () => ({ kind: "invalid" }) }), REQ);
    expect(r.kind).toBe("error");
    expect((r as { error: string }).error).toBe("expired_token");
  });
});

describe("redeemDeviceCode — approved", () => {
  it("mints a frozen token body from the approved props (scopes intersected with capability)", async () => {
    const mint = vi.fn(deps().mintScopedKey);
    const issueRefresh = vi.fn(async () => "rtk_" + "y".repeat(40));
    const r = await redeemDeviceCode(
      deps({ mintScopedKey: mint, issueRefreshToken: issueRefresh }),
      REQ,
    );
    expect(r).toEqual({
      kind: "token",
      body: {
        access_token: "whk_" + "x".repeat(40),
        token_type: "Bearer",
        expires_in: 86_400,
        refresh_token: "rtk_" + "y".repeat(40),
        scope: "events:read events:replay",
        resource: API,
      },
    });
    expect(mint).toHaveBeenCalledWith({
      orgId: "org_1",
      userId: "user_dana",
      scopes: ["events:read", "events:replay"],
      audience: API,
      ttlSeconds: 86_400,
      device: { name: "Dana's laptop" },
    });
    // the refresh handle is bound to the grant's org + audience (not the request).
    expect(issueRefresh).toHaveBeenCalledWith("grant_1", "org_1", API);
  });

  it("drops a non-capability scope from the approved props (defense in depth)", async () => {
    const mint = vi.fn(deps().mintScopedKey);
    await redeemDeviceCode(
      deps({
        poll: async () => ({
          kind: "approved",
          props: { ...APPROVED_PROPS, scopes: ["events:read", "totally:made-up"] },
        }),
        mintScopedKey: mint,
      }),
      REQ,
    );
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["events:read"] }));
  });

  it("rejects invalid_target when the approved audience is not an allowed resource", async () => {
    const r = await redeemDeviceCode(
      deps({
        poll: async () => ({
          kind: "approved",
          props: { ...APPROVED_PROPS, audience: "https://evil" },
        }),
      }),
      REQ,
    );
    expect((r as { error: string }).error).toBe("invalid_target");
  });

  it("rejects invalid_scope when nothing approved is a capability scope", async () => {
    const r = await redeemDeviceCode(
      deps({
        poll: async () => ({
          kind: "approved",
          props: { ...APPROVED_PROPS, scopes: ["nope:nope"] },
        }),
      }),
      REQ,
    );
    expect((r as { error: string }).error).toBe("invalid_scope");
  });

  it("surfaces a pending org-approval as the pending result (mints nothing)", async () => {
    const r = await redeemDeviceCode(
      deps({ mintScopedKey: async () => ({ status: "pending_approval", grantId: "grant_2" }) }),
      REQ,
    );
    expect(r).toEqual({ kind: "pending", grantId: "grant_2", interval: 5 });
  });

  it("rolls back the mint and errors server_error if the refresh handle can't be issued", async () => {
    const rollback = vi.fn(async () => {});
    const r = await redeemDeviceCode(
      deps({
        issueRefreshToken: async () => {
          throw new Error("kv down");
        },
        rollbackMint: rollback,
      }),
      REQ,
    );
    expect((r as { error: string }).error).toBe("server_error");
    expect(rollback).toHaveBeenCalledWith("grant_1", "org_1");
  });
});
