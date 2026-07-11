import type { AuthContext, UserProfile } from "@webhook-co/contract";
import { describe, expect, it, vi } from "vitest";

import { buildWhoami } from "./whoami";

const profile: UserProfile = { name: "Dana Dev", email: "dana@example.com" };
const resolver = vi.fn(async (): Promise<UserProfile | null> => profile);

describe("buildWhoami", () => {
  it("always returns orgId + userId + scopes (non-PII identity)", async () => {
    const ctx: AuthContext = { orgId: "org_1", userId: "usr_1", scopes: ["events:read"] };
    const result = await buildWhoami(ctx, resolver);
    expect(result).toEqual({ orgId: "org_1", userId: "usr_1", scopes: ["events:read"] });
    expect(resolver).not.toHaveBeenCalled(); // no profile scope → no PII lookup
  });

  it("returns name + email ONLY when the token has the profile scope + a userId", async () => {
    const ctx: AuthContext = {
      orgId: "org_1",
      userId: "usr_1",
      scopes: ["events:read", "profile"],
    };
    const result = await buildWhoami(ctx, resolver);
    expect(resolver).toHaveBeenCalledWith("usr_1");
    expect(result).toMatchObject({ name: "Dana Dev", email: "dana@example.com", userId: "usr_1" });
  });

  it("does NOT expose PII for an org-only principal (no userId) even with the profile scope", async () => {
    const r = vi.fn(async () => profile);
    const ctx: AuthContext = { orgId: "org_1", scopes: ["profile"] };
    const result = await buildWhoami(ctx, r);
    expect(r).not.toHaveBeenCalled();
    expect(result).toEqual({ orgId: "org_1", scopes: ["profile"] });
  });

  it("falls back to base identity when the user profile can't be found", async () => {
    const ctx: AuthContext = { orgId: "org_1", userId: "usr_x", scopes: ["profile"] };
    const result = await buildWhoami(ctx, async () => null);
    expect(result).toEqual({ orgId: "org_1", userId: "usr_x", scopes: ["profile"] });
  });

  it("degrades to base identity when the profile RPC throws (never fails the tool)", async () => {
    const ctx: AuthContext = { orgId: "org_1", userId: "usr_1", scopes: ["profile"] };
    const result = await buildWhoami(ctx, async () => {
      throw new Error("auth RPC down");
    });
    expect(result).toEqual({ orgId: "org_1", userId: "usr_1", scopes: ["profile"] });
  });
});
