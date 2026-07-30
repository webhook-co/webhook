import { describe, expect, it } from "vitest";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";
import { WHOAMI_ANNOTATIONS, toolAnnotations } from "./mcp-agent";

// The OpenAI plugin directory requires `readOnlyHint`, `destructiveHint` and `openWorldHint` to be
// present and explicit on EVERY tool. Its scanner does not accept a spec default: it reports
// "did not include an annotation for openWorldHint" and refuses the submission.
//
// That overrides two earlier, defensible choices in mcp-agent.ts:
//   • `openWorldHint` was left at the MCP default (true), "deliberately undecided, not decided closed"
//   • `destructiveHint` was emitted only for writes, because the spec defines it only when
//     `readOnlyHint` is false
//
// Both read correctly against the spec and both fail the directory. Leaving `openWorldHint` at its
// default was also the WORSE answer on the merits once decided: the default is `true`, meaning "may
// interact with an open world of external entities", and every tool here talks to exactly one
// well-defined entity — the webhook.co API, scoped to the caller's own org. Silence was publishing
// the more alarming claim.

describe("every bound tool carries all three directory-required hints", () => {
  // Without this the sweeps below pass vacuously on an empty set.
  it("finds a non-empty bound capability set", () => {
    expect(MCP_BOUND_CAPABILITIES.length).toBeGreaterThan(10);
  });

  it("declares readOnlyHint, destructiveHint and openWorldHint EXPLICITLY on every tool", () => {
    for (const cap of MCP_BOUND_CAPABILITIES) {
      const a = toolAnnotations(cap);
      expect(typeof a.readOnlyHint, `${cap.name}.readOnlyHint`).toBe("boolean");
      expect(typeof a.destructiveHint, `${cap.name}.destructiveHint`).toBe("boolean");
      expect(typeof a.openWorldHint, `${cap.name}.openWorldHint`).toBe("boolean");
    }
  });

  // Every tool's domain of interaction is the webhook.co API and nothing else. None fetches an
  // arbitrary URL, searches the web, or reaches an entity the caller did not name. Third-party payload
  // BYTES flowing through events.* is not the same thing: the tool still talks only to our API.
  it("marks every tool closed-world", () => {
    for (const cap of MCP_BOUND_CAPABILITIES) {
      expect(toolAnnotations(cap).openWorldHint, `${cap.name} should be closed-world`).toBe(false);
    }
  });

  // A read-only tool cannot destroy anything. Stating it beats omitting it: the MCP default for
  // destructiveHint is TRUE, so silence on a read tool was the alarming reading, not the safe one.
  it("marks every read-only tool non-destructive", () => {
    const reads = MCP_BOUND_CAPABILITIES.filter((c) => c.auth.scope.endsWith(":read"));
    expect(reads.length).toBeGreaterThan(5);
    for (const cap of reads) {
      const a = toolAnnotations(cap);
      expect(a.readOnlyHint, `${cap.name}`).toBe(true);
      expect(a.destructiveHint, `${cap.name} is read-only`).toBe(false);
    }
  });

  // The write side must still come from the CONTRACT, not from a second hand-kept list here — that
  // drift is exactly what deriving from `semantics` was meant to prevent.
  it("keeps write destructiveHint derived from the capability contract", () => {
    const writes = MCP_BOUND_CAPABILITIES.filter((c) => !c.auth.scope.endsWith(":read"));
    expect(writes.length).toBeGreaterThan(3);
    for (const cap of writes) {
      expect(toolAnnotations(cap).destructiveHint, `${cap.name}`).toBe(
        cap.semantics.destructive === true,
      );
    }
  });

  // idempotentHint is NOT directory-required and the spec defines it only for writes. Keeping it
  // gated means this change adds the three required hints without quietly widening the surface.
  it("still declares idempotentHint only for writes", () => {
    for (const cap of MCP_BOUND_CAPABILITIES.filter((c) => c.auth.scope.endsWith(":read"))) {
      expect(toolAnnotations(cap).idempotentHint, `${cap.name}`).toBeUndefined();
    }
  });
});

// whoami is registered by hand rather than from a capability, so it is exactly the tool a sweep over
// MCP_BOUND_CAPABILITIES would miss — and the directory flagged it too.
describe("whoami", () => {
  it("carries all three hints, read-only and non-destructive", () => {
    expect(WHOAMI_ANNOTATIONS.readOnlyHint).toBe(true);
    expect(WHOAMI_ANNOTATIONS.destructiveHint).toBe(false);
    expect(WHOAMI_ANNOTATIONS.openWorldHint).toBe(false);
  });
});
