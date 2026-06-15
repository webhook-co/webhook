import { CAPABILITIES, requiredSurfaces, type AnyCapability } from "@webhook-co/contract";

// The capabilities the MCP surface binds as tools: exactly those whose required GA surfaces
// include "mcp". Derived from the contract (not hand-listed) so it tracks the parity exemptions
// automatically — today that's the 5 reads + events.tail (cursor pull, slice 11); events.replay
// stays mcp-exempt until slice 12. When an exemption lifts, the capability appears here and MUST gain
// both an MCP tool registration AND a shared read handler, or the parity gate + this test fail.
export const MCP_BOUND_CAPABILITIES: readonly AnyCapability[] = CAPABILITIES.filter((c) =>
  requiredSurfaces(c).includes("mcp"),
);
