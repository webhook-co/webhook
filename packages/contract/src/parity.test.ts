import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCapability, requiredSurfaces, SURFACES } from "./capability";
import { CAPABILITIES } from "./capabilities";
import { assertCapabilityParity, emptyBindings, findParityViolations } from "./parity";

function fullBindings() {
  const b = emptyBindings();
  for (const surface of SURFACES) for (const cap of CAPABILITIES) b[surface].add(cap.name);
  return b;
}

/** Total (capability, required-surface) pairs once documented exemptions are honored. */
const requiredPairs = CAPABILITIES.reduce((n, c) => n + requiredSurfaces(c).length, 0);

describe("capability parity", () => {
  it("passes when every capability is bound on every GA surface", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, fullBindings())).not.toThrow();
  });

  it("flags a capability missing on a surface it is required on", () => {
    const b = fullBindings();
    // events.list is required on mcp (no exemption), so dropping it is a real violation.
    b.mcp.delete("events.list");
    const violations = findParityViolations(CAPABILITIES, b);
    expect(violations).toContainEqual({ capability: "events.list", surface: "mcp" });
  });

  it("does NOT flag a capability that is surfaceExempt on the missing surface", () => {
    const b = fullBindings();
    // events.replay is exempt on mcp (lands in slice 12), so dropping its mcp binding is fine.
    b.mcp.delete("events.replay");
    const violations = findParityViolations(CAPABILITIES, b);
    expect(violations).not.toContainEqual({ capability: "events.replay", surface: "mcp" });
  });

  it("reports exactly the required (capability, surface) pairs when nothing is bound", () => {
    const violations = findParityViolations(CAPABILITIES, emptyBindings());
    // Exemptions shrink the required set below CAPABILITIES.length * SURFACES.length.
    expect(violations).toHaveLength(requiredPairs);
    expect(requiredPairs).toBeLessThan(CAPABILITIES.length * SURFACES.length);
  });

  it("respects a documented surfaceExempt", () => {
    const internalOnly = defineCapability({
      name: "internal.only",
      input: z.object({}),
      output: z.object({}),
      errors: ["UNAUTHORIZED"],
      auth: { scope: "events:read" },
      semantics: {},
      surfaceExempt: { web: "no dashboard view planned", mcp: "not agent-relevant" },
    });
    const b = emptyBindings();
    b.api.add("internal.only");
    b.cli.add("internal.only");
    expect(() => assertCapabilityParity([internalOnly], b)).not.toThrow();
  });

  it("throws a readable error listing violations", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, emptyBindings())).toThrow(
      /parity violations/,
    );
  });
});

// The conformance gate: the capabilities actually bound on each surface TODAY must satisfy
// parity once the documented exemptions are honored. This encodes the live reality so that
// (a) shipping a GA surface without a required capability fails the build, and (b) an
// over-broad exemption — one that excuses a surface that IS in fact bound — is caught too.
// Slices 11/12 bind events.tail/replay on api+mcp and remove those exemptions, updating this
// map in lockstep; the frontend epic adds the web bindings and removes the WEB_DEFERRED ones.
describe("capability parity — current GA surfaces conformance", () => {
  // The real registered sets, mirrored here from each surface:
  //   cli  — packages/cli CAPABILITY_COMMANDS (all 7: `listen`/`replay` map tail/replay)
  //   api  — apps/api router (the 5 reads + events.tail cursor-pull, slice 11)
  //   mcp  — apps/mcp McpAgent tools (the same 6 capabilities)
  //   web  — none (dashboard deferred)
  const API_MCP_BOUND = [
    "endpoints.list",
    "endpoints.get",
    "events.list",
    "events.get",
    "events.tail",
    "audit.verify",
  ];
  function liveBindings() {
    const b = emptyBindings();
    for (const cap of CAPABILITIES) b.cli.add(cap.name); // CLI surfaces all 7 commands
    for (const name of API_MCP_BOUND) {
      b.api.add(name);
      b.mcp.add(name);
    }
    return b;
  }

  it("passes parity with the documented exemptions", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, liveBindings())).not.toThrow();
  });

  it("would fail if a read capability were dropped from a required surface", () => {
    const b = liveBindings();
    b.api.delete("events.get");
    expect(() => assertCapabilityParity(CAPABILITIES, b)).toThrow(
      /events\.get is not bound on api/,
    );
  });

  it("keeps exemptions tight: tail is api/cli/mcp, replay is cli-only, web is exempt everywhere", () => {
    const tail = CAPABILITIES.find((c) => c.name === "events.tail");
    const replay = CAPABILITIES.find((c) => c.name === "events.replay");
    // events.tail bound on api+mcp as of slice 11 (cursor pull); replay stays cli-only until slice 12.
    expect(requiredSurfaces(tail!)).toEqual(["api", "cli", "mcp"]);
    expect(requiredSurfaces(replay!)).toEqual(["cli"]);
    for (const cap of CAPABILITIES) {
      expect(requiredSurfaces(cap), `${cap.name} must not require web yet`).not.toContain("web");
    }
  });
});
