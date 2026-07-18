import { describe, expect, it } from "vitest";

import {
  AGENT_FILL_RAMP,
  DEFAULT_FLOW_TIMING,
  NODE_LIGHT_RAMP,
  NODE_LIGHT_STAGGER,
  RETURN_PAYLOAD_DELAY,
  SOURCE_INDEX_DEFAULT,
  TARGET_INDEX_DEFAULT,
  TRAVEL_FRAMES,
  TRAVEL_START_OFFSET,
  flowNodeLitFrame,
  flowReturnPayloadFrame,
  flowTravelStartFrame,
  flowWakeFrame,
  nodeLitProgress,
  tokenTravelProgress,
} from "./FlowDiagram";

// The exported timing helpers are the contract the S16 scene syncs against (the
// wake thunk, the RingPulse, and the `triggers.wait` return payload all key off
// these frames). Getting them wrong desyncs the film's biggest beat, so each is
// asserted both structurally and against the brief §5 S16 comp frames (the scene
// maps comp f1350 → local f0).

describe("flowTravelStartFrame", () => {
  it("is startFrame + TRAVEL_START_OFFSET", () => {
    expect(flowTravelStartFrame(0)).toBe(TRAVEL_START_OFFSET);
    expect(flowTravelStartFrame(1350)).toBe(1350 + TRAVEL_START_OFFSET);
  });

  it("matches the brief's S16 beat: the token departs at comp f1400", () => {
    // scene startFrame 0 → the token leaves `verified` at local f50 (comp f1400).
    expect(flowTravelStartFrame(0)).toBe(50);
  });
});

describe("flowWakeFrame", () => {
  it("is travel-start + TRAVEL_FRAMES", () => {
    expect(flowWakeFrame(0)).toBe(TRAVEL_START_OFFSET + TRAVEL_FRAMES);
  });

  it("matches the brief's S16 wake: the agent springs to life at local f80 (comp f1430)", () => {
    expect(flowWakeFrame(0)).toBe(80);
    expect(flowWakeFrame(1350)).toBe(1430);
  });
});

describe("flowReturnPayloadFrame", () => {
  it("is the wake frame + RETURN_PAYLOAD_DELAY", () => {
    expect(flowReturnPayloadFrame(0)).toBe(flowWakeFrame(0) + RETURN_PAYLOAD_DELAY);
  });

  it("matches the brief's S16: the return payload prints at local f85 (comp f1435)", () => {
    expect(flowReturnPayloadFrame(0)).toBe(85);
    expect(flowReturnPayloadFrame(1350)).toBe(1435);
  });

  it("prints strictly after the wake (payload is a consequence of it, never before)", () => {
    expect(flowReturnPayloadFrame(0)).toBeGreaterThan(flowWakeFrame(0));
  });
});

// flowNodeLitFrame is the three-part light schedule: upstream nodes light in a
// staggered establishing sequence; the target (agent) lights ONLY when the token
// arrives (the wake); downstream nodes light after.
describe("flowNodeLitFrame", () => {
  it("lights upstream nodes in a staggered sequence by node order", () => {
    expect(flowNodeLitFrame(0, 0)).toBe(0); // event
    expect(flowNodeLitFrame(1, 0)).toBe(NODE_LIGHT_STAGGER); // verified
  });

  it("lights the source node before the token departs it (source must be lit to emit)", () => {
    const sourceLit = flowNodeLitFrame(SOURCE_INDEX_DEFAULT, 0) + NODE_LIGHT_RAMP;
    expect(sourceLit).toBeLessThan(flowTravelStartFrame(0));
  });

  it("lights the target (agent) node exactly at the wake frame — not before", () => {
    expect(flowNodeLitFrame(TARGET_INDEX_DEFAULT, 0)).toBe(flowWakeFrame(0));
  });

  it("lights downstream nodes after the wake, staggered by downstreamLightDelay", () => {
    const action = 3; // `action` in the default chain
    expect(flowNodeLitFrame(action, 0)).toBe(
      flowWakeFrame(0) + (action - TARGET_INDEX_DEFAULT) * DEFAULT_FLOW_TIMING.downstreamLightDelay,
    );
    expect(flowNodeLitFrame(action, 0)).toBeGreaterThan(flowWakeFrame(0));
  });
});

// nodeLitProgress is each node's 0→1 fill intensity. The upstream/downstream
// nodes ramp over NODE_LIGHT_RAMP; the target (agent) ramps over the faster
// AGENT_FILL_RAMP and — crucially — is 0 (parked/dim) until the token arrives.
describe("nodeLitProgress", () => {
  it("is 0 before a node's light frame and 1 once its ramp completes (upstream)", () => {
    const lit = flowNodeLitFrame(0, 0);
    expect(nodeLitProgress(0, lit - 1, 0)).toBe(0);
    expect(nodeLitProgress(0, lit, 0)).toBe(0);
    expect(nodeLitProgress(0, lit + NODE_LIGHT_RAMP, 0)).toBe(1);
    expect(nodeLitProgress(0, lit + NODE_LIGHT_RAMP + 50, 0)).toBe(1);
  });

  it("keeps the agent PARKED (0) right up to the wake, then FILLS to 1", () => {
    const wake = flowWakeFrame(0);
    // Parked through the entire node-light sequence and the token's whole travel.
    expect(nodeLitProgress(TARGET_INDEX_DEFAULT, 0, 0)).toBe(0);
    expect(nodeLitProgress(TARGET_INDEX_DEFAULT, wake - 1, 0)).toBe(0);
    // Fills over the faster agent ramp once the token lands.
    expect(nodeLitProgress(TARGET_INDEX_DEFAULT, wake, 0)).toBe(0);
    expect(nodeLitProgress(TARGET_INDEX_DEFAULT, wake + AGENT_FILL_RAMP, 0)).toBe(1);
  });

  it("is strictly between 0 and 1 partway through a node's fill", () => {
    const lit = flowNodeLitFrame(0, 0);
    const mid = nodeLitProgress(0, lit + NODE_LIGHT_RAMP / 2, 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("is monotonically non-decreasing across a node's fill window", () => {
    const lit = flowNodeLitFrame(1, 0);
    let prev = -Infinity;
    for (let f = lit - 3; f <= lit + NODE_LIGHT_RAMP + 3; f++) {
      const p = nodeLitProgress(1, f, 0);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

// tokenTravelProgress is the physical crossing: it rests at 0 until the departure
// frame, climbs to exactly 1 AT the wake (arrival == wake), never overshoots, and
// is monotonic — the token moves forward into the agent and does not bounce.
describe("tokenTravelProgress", () => {
  it("is 0 before and at the moment of departure", () => {
    const start = flowTravelStartFrame(0);
    expect(tokenTravelProgress(start - 5, 0)).toBe(0);
    expect(tokenTravelProgress(start, 0)).toBe(0);
  });

  it("reaches exactly 1 at the wake frame and clamps there afterward", () => {
    const wake = flowWakeFrame(0);
    expect(tokenTravelProgress(wake, 0)).toBe(1);
    expect(tokenTravelProgress(wake + 100, 0)).toBe(1);
  });

  it("is strictly between 0 and 1 partway across the connector", () => {
    const start = flowTravelStartFrame(0);
    const mid = tokenTravelProgress(start + TRAVEL_FRAMES / 2, 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("is monotonically non-decreasing across the whole travel window", () => {
    let prev = -Infinity;
    for (let f = flowTravelStartFrame(0) - 2; f <= flowWakeFrame(0) + 2; f++) {
      const p = tokenTravelProgress(f, 0);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("never exceeds 1 or drops below 0 anywhere in a wide window", () => {
    for (let f = -20; f <= flowWakeFrame(0) + 200; f++) {
      const p = tokenTravelProgress(f, 0);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("honors a non-zero startFrame (comp-frame S16: departs f1400, lands f1430)", () => {
    expect(tokenTravelProgress(1400, 1350)).toBe(0);
    expect(tokenTravelProgress(1430, 1350)).toBe(1);
  });
});
