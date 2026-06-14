import { describe, expect, it } from "vitest";

import { mcpApiHandler } from "./api-handler";
import type { McpEnv } from "./env";

const ORG = "44444444-4444-7444-8444-444444444444";
const env = {} as McpEnv;

/** A minimal stand-in for the ExecutionContext the OAuthProvider augments with the grant `props`. */
const ctxWith = (props: unknown) => ({ props }) as unknown as ExecutionContext;
const mcpRequest = () => new Request("https://mcp.webhook.co/mcp", { method: "POST" });

describe("mcpApiHandler", () => {
  it("returns the authenticated AuthContext for a valid grant (incl. userId)", async () => {
    const res = await mcpApiHandler.fetch(
      mcpRequest(),
      env,
      ctxWith({ orgId: ORG, userId: "user_1", scopes: ["events:read"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: ORG, userId: "user_1", scopes: ["events:read"] });
  });

  it("omits userId when the grant has none", async () => {
    const res = await mcpApiHandler.fetch(mcpRequest(), env, ctxWith({ orgId: ORG, scopes: [] }));
    expect(await res.json()).toEqual({ orgId: ORG, scopes: [] });
  });

  it("fails closed with a generic 500 on a malformed grant (no half-principal, no leak)", async () => {
    const res = await mcpApiHandler.fetch(mcpRequest(), env, ctxWith({ orgId: "", scopes: [] }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
  });

  it("fails closed when props are entirely absent", async () => {
    const res = await mcpApiHandler.fetch(mcpRequest(), env, ctxWith(undefined));
    expect(res.status).toBe(500);
  });
});
