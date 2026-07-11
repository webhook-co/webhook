import { describe, expect, it } from "vitest";

import { resolveAudience } from "./audience";

const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";
const ALLOWED = [API, MCP];

describe("resolveAudience", () => {
  it("accepts an exact permitted audience and returns it canonical", () => {
    expect(resolveAudience(MCP, ALLOWED)).toBe(MCP);
    expect(resolveAudience(API, ALLOWED)).toBe(API);
  });

  it("accepts the MCP-SDK trailing-slash form and returns the CANONICAL (no-slash) value", () => {
    // new URL("https://mcp.webhook.co").href === "https://mcp.webhook.co/" — what Claude Code/Desktop send.
    // The returned value must be the path-less canonical one so the minted token audience matches what the
    // MCP server validates (MCP_RESOURCE, no slash) — this is the invalid_target fix.
    expect(resolveAudience("https://mcp.webhook.co/", ALLOWED)).toBe(MCP);
    expect(resolveAudience("https://api.webhook.co/", ALLOWED)).toBe(API);
  });

  it("accepts a single-element array (RFC 8707 allows repeated resource)", () => {
    expect(resolveAudience([MCP], ALLOWED)).toBe(MCP);
    expect(resolveAudience(["https://mcp.webhook.co/"], ALLOWED)).toBe(MCP);
  });

  it("rejects a missing, multiple, or empty resource (never defaulted, never widened)", () => {
    expect(resolveAudience(undefined, ALLOWED)).toBeNull();
    expect(resolveAudience([], ALLOWED)).toBeNull();
    expect(resolveAudience([API, MCP], ALLOWED)).toBeNull();
  });

  it("rejects a non-permitted origin — trailing-slash tolerance never widens the set", () => {
    expect(resolveAudience("https://evil.com", ALLOWED)).toBeNull();
    expect(resolveAudience("https://evil.com/", ALLOWED)).toBeNull();
    // a lookalike / suffix must not slip through
    expect(resolveAudience("https://mcp.webhook.co.evil.com/", ALLOWED)).toBeNull();
    // a double trailing slash strips only ONE and still misses (not a real client shape)
    expect(resolveAudience("https://mcp.webhook.co//", ALLOWED)).toBeNull();
    // a path variant is NOT silently accepted (the SDK sends the PRM origin, not the /mcp path)
    expect(resolveAudience("https://mcp.webhook.co/mcp", ALLOWED)).toBeNull();
  });
});
