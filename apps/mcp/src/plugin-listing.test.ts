import { describe, expect, it } from "vitest";

// The REAL manifest, imported so the bundler resolves it at build time. apps/mcp's suite runs in the
// workerd pool, which has no filesystem — `readFileSync` here fails to COLLECT the file, which surfaces as
// "1 failed" with zero failing tests rather than as a normal assertion failure.
import manifest from "../../../plugin/webhook-co/.codex-plugin/plugin.json";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";

// The published plugin listing (plugin/webhook-co, ADR-0132) declares `interface.capabilities`, which is what
// a user sees and consents to before installing. It shipped as ["Interactive"] alone while this server
// exposed endpoints.create/delete/rotate/update, events.delete and triggers.create/revoke — so the listing
// UNDERSTATED what the plugin could do.
//
// That direction of drift is the dangerous one. An overstated capability is a cosmetic wart; an understated
// one means someone approved a plugin described as read-and-chat and installed one that can delete an
// endpoint. So derive the answer from the bound capability set rather than trusting the manifest's own word.
//
// This test lives in apps/mcp, NOT in packages/contract, and that placement is the point:
// MCP_BOUND_CAPABILITIES is the set actually registered as tools (`requiredSurfaces(c).includes("mcp")`),
// which is a SUBSET of the full registry. Deriving from CAPABILITIES would have demanded "Write" on the
// strength of write capabilities the plugin does not expose at all — replayDestinations.delete and
// subscriptions.delete are in the registry and are not MCP tools. Right answer, wrong reason.

/** A scope that mutates. `events:replay` re-delivers, which is an effect on the world, not a read. */
const MUTATING = /:(write|delete|replay)$/;

describe("the published plugin listing describes what the MCP surface can actually do", () => {
  const declared: string[] = manifest.interface.capabilities;

  // The floor: if the manifest stops being MCP-backed, every assertion below is reasoning about a plugin
  // that exposes no tools, and it should say so loudly rather than keep passing.
  it("is an MCP-backed listing (else these assertions are vacuous)", () => {
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(MCP_BOUND_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it("declares Write, because the bound tools include mutating ones", () => {
    const mutating = MCP_BOUND_CAPABILITIES.filter((c) => MUTATING.test(c.auth.scope)).map(
      (c) => c.name,
    );
    // Non-vacuous: prove there IS something to declare before requiring the declaration.
    expect(mutating.length).toBeGreaterThan(0);
    expect(declared).toContain("Write");
  });

  it("declares Read, because the bound tools include read-only ones", () => {
    const reading = MCP_BOUND_CAPABILITIES.filter((c) => c.auth.scope.endsWith(":read"));
    expect(reading.length).toBeGreaterThan(0);
    expect(declared).toContain("Read");
  });

  it("uses only OpenAI's three canonical capability values", () => {
    // The corpus contains free-text capability lists ("Realtime apps", "News monitoring"). They render, but
    // Read/Write/Interactive are the values the directory actually reasons about.
    expect(new Set(declared)).toEqual(new Set(["Interactive", "Read", "Write"]));
  });

  it("pins every DESTRUCTIVE tool the plugin exposes, so none is added unnoticed", () => {
    // A change to this list is a change to what an installed plugin can destroy on a user's account. It
    // should be a deliberate diff in review, not a silent consequence of a capability gaining an mcp surface.
    const destructive = MCP_BOUND_CAPABILITIES.filter((c) => c.semantics?.destructive === true)
      .map((c) => c.name)
      .sort();
    expect(destructive).toEqual([
      "endpoints.delete",
      "endpoints.revokeProviderSecret",
      "endpoints.rotate",
      "events.delete",
      "triggers.revoke",
    ]);
  });
});
