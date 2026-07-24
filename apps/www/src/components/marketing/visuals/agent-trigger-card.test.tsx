import { CAPABILITY_REGISTRY } from "@webhook-co/contract";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { AgentTriggerCard, SHOWN_ARGS, TRIGGER_TOOLS } from "./agent-trigger-card";

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

/** A syntactically valid uuid for the id fields the card elides as "…". */
const UUID = "9f2c8b1e-0d3a-4c5e-8f7a-1b2c3d4e5f60";

describe("AgentTriggerCard", () => {
  it("names only capabilities that actually exist in the contract", () => {
    // Anti-vacuity: if REAL_TOOLS were empty (wrong registry API), a subset check would pass for free.
    expect(REAL_TOOLS.size).toBeGreaterThan(10);
    expect(TRIGGER_TOOLS.length).toBeGreaterThan(0);
    for (const tool of TRIGGER_TOOLS) {
      expect(REAL_TOOLS, `${tool} is not a real capability`).toContain(tool);
    }
  });

  // The name check above is necessary and was NOT sufficient. This card shipped
  // `triggers.create { endpointId, eventTypes: [...] }` — both tool names real, the argument invented
  // (it belongs to subscriptions.create). The input schema strips unknown keys instead of rejecting
  // them, so following the card would have silently produced an UNFILTERED trigger. A guard that
  // checks names while the lie lives in the arguments reports coverage it does not have.
  it("shows only arguments that exist on the real capability input schema", () => {
    for (const tool of TRIGGER_TOOLS) {
      const capability = CAPABILITY_REGISTRY.get(tool);
      expect(capability, `${tool} missing from registry`).toBeDefined();

      const shown = SHOWN_ARGS[tool];
      expect(Object.keys(shown).length, `${tool} pins no arguments`).toBeGreaterThan(0);

      // parse() throws on a bad field only if the schema is strict; it is not. So assert on the
      // schema's OWN key set — the only thing that distinguishes "accepted" from "silently dropped".
      const accepted = new Set(Object.keys(capability!.input.shape));
      expect(accepted.size, `${tool} input schema looks empty`).toBeGreaterThan(0);
      for (const field of Object.keys(shown)) {
        expect(
          accepted,
          `${tool} has no "${field}" input — it would be silently ignored`,
        ).toContain(field);
      }
      // And the values we show must actually satisfy it (uuid fields excepted — the card elides them).
      expect(() =>
        capability!.input.parse({ ...shown, endpointId: UUID, triggerId: UUID }),
      ).not.toThrow();
    }
  });

  it("renders the pinned arguments, so the pin tracks what a reader sees", () => {
    const { container } = render(<AgentTriggerCard />);
    const text = container.textContent ?? "";
    for (const shown of Object.values(SHOWN_ARGS)) {
      for (const field of Object.keys(shown)) expect(text).toContain(field);
    }
    expect(text, "eventTypes is a subscriptions field, never a trigger field").not.toContain(
      "eventTypes",
    );
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
