import { CAPABILITY_REGISTRY } from "@webhook-co/contract";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { AgentTriggerCard, TRIGGER_TOOLS } from "./agent-trigger-card";

// The agent-trigger page is what makes the "built for the agent era" headline cashable, so what it
// shows has to be what the product does. Two things are pinned here:
//   1. the tool names are REAL (from the capability contract — not plausible-looking inventions), and
//   2. the semantics are the real ones. `triggers.wait` is a caller-driven SHORT POLL acknowledged by
//      cursor. The "blocks until an event arrives" / "pushes to your agent" framing was factually
//      wrong in three places in this repo and was corrected as truth-debt; a marketing visual is
//      exactly how it would sneak back in.

// The registry is a test-only import (it must not enter the static-export bundle). It's a Map keyed
// by capability name — Object.keys() on it silently yields [], which would make every assertion below
// pass for the wrong reason, so the count check right after this is load-bearing.
const REAL_TOOLS = new Set(CAPABILITY_REGISTRY.keys());

describe("AgentTriggerCard", () => {
  it("names only capabilities that actually exist in the contract", () => {
    // Anti-vacuity: if REAL_TOOLS were empty (wrong registry API), a subset check would pass for free.
    expect(REAL_TOOLS.size).toBeGreaterThan(10);
    expect(TRIGGER_TOOLS.length).toBeGreaterThan(0);
    for (const tool of TRIGGER_TOOLS) {
      expect(REAL_TOOLS, `${tool} is not a real capability`).toContain(tool);
    }
  });

  it("shows the tools it claims to show", () => {
    const { container } = render(<AgentTriggerCard />);
    const text = container.textContent ?? "";
    for (const tool of TRIGGER_TOOLS) expect(text).toContain(tool);
  });

  it("shows the cursor ack — the mechanism that makes delivery at-least-once", () => {
    const { container } = render(<AgentTriggerCard />);
    expect(container.textContent).toMatch(/cursor/i);
  });

  it("NEVER frames triggers.wait as a push or a blocking call", () => {
    const { container } = render(<AgentTriggerCard />);
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(50); // non-vacuous
    for (const lie of [
      /blocks? until/i,
      /\bpush(es|ed)?\b/i,
      /real-?time/i,
      /streams? to your agent/i,
    ]) {
      expect(text, `must not claim ${lie}`).not.toMatch(lie);
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<AgentTriggerCard />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
