import { CapabilityFault } from "@webhook-co/contract";
import type { AuthContext } from "@webhook-co/contract";
import type { ReadHandler, ReadHandlers } from "@webhook-co/db";
import { describe, expect, it, vi } from "vitest";

import { runCapabilityTool } from "./tools";

const CTX: AuthContext = { orgId: "org_1", scopes: ["endpoints:read"] };

function handlersOf(name: string, fn: ReadHandler): ReadHandlers {
  return new Map([[name, fn]]);
}

describe("runCapabilityTool", () => {
  it("shapes a successful read as a single JSON text content block", async () => {
    const output = { items: [{ id: "ep_1" }], nextCursor: null };
    const log = vi.fn();
    const result = await runCapabilityTool(
      handlersOf("endpoints.list", async () => output),
      "endpoints.list",
      CTX,
      { limit: 10 },
      log,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(output) }]);
    expect(JSON.parse(result.content[0].text)).toEqual(output);
    expect(log).not.toHaveBeenCalled();
  });

  it("passes the AuthContext and input straight through to the shared handler", async () => {
    let seen: { ctx: AuthContext; input: unknown } | undefined;
    await runCapabilityTool(
      handlersOf("endpoints.get", async (ctx, input) => {
        seen = { ctx, input };
        return { id: "ep_1" };
      }),
      "endpoints.get",
      CTX,
      { endpointId: "ep_1" },
      vi.fn(),
    );
    expect(seen?.ctx).toBe(CTX);
    expect(seen?.input).toEqual({ endpointId: "ep_1" });
  });

  it("maps a CapabilityFault to an isError result carrying the closed-taxonomy code", async () => {
    const log = vi.fn();
    const result = await runCapabilityTool(
      handlersOf("endpoints.get", async () => {
        throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      }),
      "endpoints.get",
      CTX,
      { endpointId: "missing" },
      log,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: "NOT_FOUND",
      message: "endpoint not found",
    });
    // A capability fault is an expected, client-facing outcome — not an operational error to log.
    expect(log).not.toHaveBeenCalled();
  });

  it("maps a FORBIDDEN scope fault to isError (the MCP analogue of API 403)", async () => {
    const result = await runCapabilityTool(
      handlersOf("audit.verify", async () => {
        throw new CapabilityFault("FORBIDDEN", "missing required scope: audit:read");
      }),
      "audit.verify",
      CTX,
      {},
      vi.fn(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("FORBIDDEN");
  });

  it("masks an operational fault as a generic error and logs it (never echoes internals)", async () => {
    const log = vi.fn();
    const result = await runCapabilityTool(
      handlersOf("events.list", async () => {
        throw new Error("hyperdrive connection reset");
      }),
      "events.list",
      CTX,
      { endpointId: "ep_1" },
      log,
    );
    expect(result.isError).toBe(true);
    // The internal message must NOT reach the client — only a generic error does.
    expect(result.content[0].text).toBe("internal error");
    expect(result.content[0].text).not.toContain("hyperdrive");
    expect(log).toHaveBeenCalledWith("mcp.tool_unhandled", {
      capability: "events.list",
      error: "Error: hyperdrive connection reset",
    });
  });

  it("returns a generic error + logs a wiring fault when no handler is bound", async () => {
    const log = vi.fn();
    const result = await runCapabilityTool(new Map(), "endpoints.list", CTX, {}, log);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("internal error");
    expect(log).toHaveBeenCalledWith("mcp.no_handler", { capability: "endpoints.list" });
  });
});
