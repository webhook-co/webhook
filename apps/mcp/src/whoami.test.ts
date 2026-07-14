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

describe("buildWhoami — bound org identity (tenant identity, always returned when resolvable)", () => {
  const ORG = { id: "org_1", slug: "acme", name: "Acme Inc" };

  it("includes organization {id,slug,name} when the org resolver is wired — NOT gated on the profile scope", async () => {
    // org identity is TENANT identity (like orgId), not user PII, so unlike name/email it needs no consent.
    const ctx: AuthContext = { orgId: "org_1", scopes: [] };
    const result = await buildWhoami(ctx, resolver, async () => ORG);
    expect(result).toEqual({ orgId: "org_1", scopes: [], organization: ORG });
  });

  it("omits organization when no org resolver is wired (forward-compat) — and never logs the no-op", async () => {
    const log = vi.fn();
    const ctx: AuthContext = { orgId: "org_1", scopes: [] };
    expect(await buildWhoami(ctx, resolver, undefined, log)).toEqual({
      orgId: "org_1",
      scopes: [],
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("degrades + logs a distinct reason on null / degenerate / fault — never fails whoami", async () => {
    const ctx: AuthContext = { orgId: "org_1", scopes: [] };

    const log1 = vi.fn();
    expect(await buildWhoami(ctx, resolver, async () => null, log1)).toEqual({
      orgId: "org_1",
      scopes: [],
    });
    expect(log1).toHaveBeenCalledWith("mcp.whoami_org_enrich_skipped", { reason: "org_not_found" });

    const log2 = vi.fn();
    // empty name fails the shared OrganizationSchema → omitted, logged invalid_org.
    await buildWhoami(ctx, resolver, async () => ({ id: "org_1", slug: "acme", name: "" }), log2);
    expect(log2).toHaveBeenCalledWith("mcp.whoami_org_enrich_skipped", { reason: "invalid_org" });

    const log3 = vi.fn();
    await buildWhoami(
      ctx,
      resolver,
      async () => {
        throw new Error("tenant pool exhausted");
      },
      log3,
    );
    expect(log3).toHaveBeenCalledWith("mcp.whoami_org_enrich_failed");
  });

  it("does NOT hang on a slow/stuck org read — abandons at the timeout and returns the base identity", async () => {
    const log = vi.fn();
    const ctx: AuthContext = { orgId: "org_1", scopes: [] };
    const started = Date.now();
    // 20ms bound: the never-resolving read is abandoned promptly, well before any MCP transport timeout.
    const result = await buildWhoami(ctx, resolver, () => new Promise<never>(() => {}), log, 20);
    expect(result).toEqual({ orgId: "org_1", scopes: [] });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(log).toHaveBeenCalledWith("mcp.whoami_org_enrich_timeout");
  });

  it("carries both organization AND profile PII when the profile scope is present", async () => {
    const ctx: AuthContext = { orgId: "org_1", userId: "usr_1", scopes: ["profile"] };
    const result = await buildWhoami(ctx, resolver, async () => ORG);
    expect(result).toMatchObject({
      orgId: "org_1",
      organization: ORG,
      name: "Dana Dev",
      email: "dana@example.com",
    });
  });
});
