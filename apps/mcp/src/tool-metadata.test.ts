import type { AnyCapability } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";
import { toolDescription, toolTitle } from "./mcp-agent";

// A tool's `description` is what the MODEL reads when deciding whether to call it. `endpoints.update`
// shipped with its description set to the literal string "endpoints.update", because registration did
// `TOOL_DESCRIPTIONS[cap.name] ?? cap.name` — present, non-empty, and completely uninformative.
//
// The asymmetry is the actual bug. `toolTitle` already THREW on a missing entry, with a comment saying a
// fallback "passes a presence check while telling a user nothing". That reasoning applies at least as
// strongly to the description, which is the field an agent actually reasons over — and it was the one
// with the silent fallback.
//
// Throwing fails at Durable Object init, i.e. in production. The sweep below is what turns that into a CI
// failure instead, so a newly bound capability cannot reach a deploy with a placeholder description.

/** A capability the maps cannot possibly know about. */
const UNKNOWN = {
  name: "totally.unknown",
  auth: { scope: "events:read" },
} as unknown as AnyCapability;

describe("tool metadata is complete for every bound capability", () => {
  it("finds a non-empty bound set (else the sweeps below prove nothing)", () => {
    expect(MCP_BOUND_CAPABILITIES.length).toBeGreaterThan(10);
  });

  it("every bound capability has a real title", () => {
    for (const cap of MCP_BOUND_CAPABILITIES) {
      expect(() => toolTitle(cap), `no title for ${cap.name}`).not.toThrow();
    }
  });

  it("every bound capability has a real description", () => {
    for (const cap of MCP_BOUND_CAPABILITIES) {
      expect(() => toolDescription(cap), `no description for ${cap.name}`).not.toThrow();
    }
  });

  it("no description is merely the tool's own name", () => {
    // The exact defect: a fallback that satisfies "is a non-empty string" and says nothing. This catches
    // it even if someone reintroduces the fallback by writing the name out as a literal entry.
    for (const cap of MCP_BOUND_CAPABILITIES) {
      expect(toolDescription(cap), `${cap.name} description is just its name`).not.toBe(cap.name);
    }
  });

  it("descriptions are substantial enough to disambiguate a tool", () => {
    for (const cap of MCP_BOUND_CAPABILITIES) {
      expect(toolDescription(cap).length, `${cap.name} description is too short`).toBeGreaterThan(
        20,
      );
    }
  });

  it("both helpers THROW for an unknown capability rather than inventing metadata", () => {
    expect(() => toolTitle(UNKNOWN)).toThrow(/TOOL_TITLES/);
    expect(() => toolDescription(UNKNOWN)).toThrow(/TOOL_DESCRIPTIONS/);
  });
});
