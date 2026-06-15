import { CAPABILITIES, requiredSurfaces } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";

// The MCP surface's drift guard (mirrors the CLI's command↔capability parity test). The tools the
// McpAgent registers are exactly MCP_BOUND_CAPABILITIES; this pins that set to the contract so a new
// mcp-required capability can't ship without a tool, and a removed exemption fails loudly here.
describe("MCP bound capabilities", () => {
  const names = MCP_BOUND_CAPABILITIES.map((c) => c.name).sort();

  it("binds the 5 reads + events.tail cursor-pull as of slice 11", () => {
    expect(names).toEqual(
      [
        "audit.verify",
        "endpoints.get",
        "endpoints.list",
        "events.get",
        "events.list",
        "events.tail",
      ].sort(),
    );
  });

  it("equals every capability whose required surfaces include mcp", () => {
    const required = CAPABILITIES.filter((c) => requiredSurfaces(c).includes("mcp"))
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(required);
  });

  it("still excludes events.replay (mcp-exempt until slice 12)", () => {
    expect(names).not.toContain("events.replay");
  });
});
