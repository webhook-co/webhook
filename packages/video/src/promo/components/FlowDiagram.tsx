// FlowDiagram — the film's climax (brief §4.11 / §5 S16 / money-frame #3, "the
// wake").
//
// A horizontal `event → verified → agent → action` flow. The upstream nodes
// (event, verified) light in sequence; a single GREEN token (`colors.verified`)
// then physically TRAVELS the connector from the `verified` node into the
// `agent` node; on arrival the parked `agent` node FILLS (dim outline → green)
// and springs to life with the §3.4 land overshoot; the downstream `action`
// node lights just after. This is the biggest musical release in the film
// (brief §7, f1430), so it is kept deliberately legible — one token, one wake.
//
// Accent discipline (brief §3.1 / repo rules): Act III is dark and green is the
// ONLY saturated accent — nothing here ever renders `colors.failed`/amber. The
// traveling token, the connector fill behind it, and the woken agent are all
// `colors.verified`; parked/unlit geometry is neutral (`termBorder` / `termBg2`
// / `termDim`). "Parked vs woke" reads through fill + glow + the pop, never
// through an alert color.
//
// PROP-SHAPE ADAPTATION (brief §4.11 lists `{ nodes, litUpToFrame,
// travelTokenState }`): those two motion props are folded INTO the component.
// Every other promo component derives all motion from `useCurrentFrame()`
// (§3.4 determinism rule) rather than having the scene pass in pre-computed
// motion — so instead of the scene handing down `litUpToFrame` /
// `travelTokenState`, FlowDiagram takes a single `startFrame` and derives, for
// the current frame: which nodes are lit (`nodeLitProgress` — the honest form of
// "lit up to frame"), and where the token is (`tokenTravelProgress` — the honest
// form of "travel token state"). The scene stays declarative; the diagram owns
// its clock. The wake/return-payload frames the scene DOES need to synchronise
// its own beats (the transcript's `triggers.wait` return, the wake thunk SFX,
// the RingPulse) are exported as pure helpers: `flowWakeFrame`,
// `flowReturnPayloadFrame`, `flowTravelStartFrame`, `flowNodeLitFrame`.
//
// All motion is a pure function of `useCurrentFrame()` — no Math.random /
// Date.now, no CSS transitions/keyframes. The token-travel + node-light + fill
// math takes no Remotion hooks (mirrors `Packet.getPacketLandFrame` /
// `DeliveryFlow`'s progress split / `VerifiedBadge.badgePopScale`), so it is
// unit-tested directly in `FlowDiagram.test.ts`. The wake pop + glow REUSE
// `VerifiedBadge`'s `badgePopScale` / `badgeGlowOpacity` (exactly like
// `EventRow` and `DeliveryFlow` do) so the whole film shares ONE "land" motion.

import { Easing, interpolate, interpolateColors, useCurrentFrame, useVideoConfig } from "remotion";

import { colors, type } from "../tokens";
import { mono } from "../fonts";
import { badgeGlowOpacity, badgePopScale } from "./VerifiedBadge";

const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);

// ── Timing constants (scene-local frames; tuned to brief §5 S16, where the
// scene maps comp f1350 → local f0). ────────────────────────────────────────

/** Frames between successive UPSTREAM nodes lighting green (event → verified). */
export const NODE_LIGHT_STAGGER = 20;
/** Frames a node takes to ramp 0 → 100% lit once its light frame arrives. */
export const NODE_LIGHT_RAMP = 14;
/** Frames after `startFrame` the token departs the source node onto the connector. */
export const TRAVEL_START_OFFSET = 50;
/** Frames the token spends traveling source → target (arrival == the wake). */
export const TRAVEL_FRAMES = 30;
/** Frames the target (agent) node takes to FILL dim → green once the token arrives. */
export const AGENT_FILL_RAMP = 8;
/** Frames after the wake a downstream node (action) lights. */
export const DOWNSTREAM_LIGHT_DELAY = 8;
/** Frames after the wake the scene's `triggers.wait` RETURN payload should print. */
export const RETURN_PAYLOAD_DELAY = 5;

/** Default index the token departs FROM — `verified` in the S16 chain. */
export const SOURCE_INDEX_DEFAULT = 1;
/** Default index the token arrives AT / wakes — `agent` in the S16 chain. Adjacent to source. */
export const TARGET_INDEX_DEFAULT = 2;

/** The default node chain (brief §5 S16 / CAPTIONS "event → verified → agent → action"). */
export const FLOW_NODES_DEFAULT = ["event", "verified", "agent", "action"] as const;

/**
 * The tunable timing/topology of a flow. Every pure helper takes one of these so
 * the math generalises past the 4-node S16 case and stays directly testable.
 * `sourceIndex`/`targetIndex` must satisfy `targetIndex === sourceIndex + 1`
 * (the token traverses exactly one connector) and both must be in-bounds.
 */
export interface FlowTiming {
  nodeLightStagger: number;
  nodeLightRamp: number;
  travelStartOffset: number;
  travelFrames: number;
  agentFillRamp: number;
  downstreamLightDelay: number;
  sourceIndex: number;
  targetIndex: number;
}

export const DEFAULT_FLOW_TIMING: FlowTiming = {
  nodeLightStagger: NODE_LIGHT_STAGGER,
  nodeLightRamp: NODE_LIGHT_RAMP,
  travelStartOffset: TRAVEL_START_OFFSET,
  travelFrames: TRAVEL_FRAMES,
  agentFillRamp: AGENT_FILL_RAMP,
  downstreamLightDelay: DOWNSTREAM_LIGHT_DELAY,
  sourceIndex: SOURCE_INDEX_DEFAULT,
  targetIndex: TARGET_INDEX_DEFAULT,
};

// ── Pure timing helpers (no Remotion hooks — unit-tested in FlowDiagram.test.ts). ──

/** Absolute (scene-local) frame the token departs the source node onto the connector. */
export function flowTravelStartFrame(startFrame: number, timing: FlowTiming = DEFAULT_FLOW_TIMING) {
  return startFrame + timing.travelStartOffset;
}

/**
 * THE wake frame — the frame the token reaches the target and the agent node
 * fills + springs to life (brief's f1430, "the biggest musical release"). The
 * scene fires its wake-thunk SFX + RingPulse here and holds the money frame from
 * here. Equals travel-start + travelFrames.
 */
export function flowWakeFrame(startFrame: number, timing: FlowTiming = DEFAULT_FLOW_TIMING) {
  return flowTravelStartFrame(startFrame, timing) + timing.travelFrames;
}

/**
 * The frame the scene's `triggers.wait` RETURN payload should begin printing —
 * a few frames after the wake so the payload reads as a consequence of it
 * (brief §5 S16: wake f1430, payload prints f1435). Wake frame + RETURN_PAYLOAD_DELAY.
 */
export function flowReturnPayloadFrame(
  startFrame: number,
  timing: FlowTiming = DEFAULT_FLOW_TIMING,
) {
  return flowWakeFrame(startFrame, timing) + RETURN_PAYLOAD_DELAY;
}

/**
 * The frame node `index` becomes lit (begins its 0 → 1 fill ramp):
 *  - upstream (index < target): staggered by node order — the establishing sequence.
 *  - target   (index == target): the wake frame — it lights only when the token arrives.
 *  - downstream (index > target): after the wake, staggered by `downstreamLightDelay`.
 */
export function flowNodeLitFrame(
  index: number,
  startFrame: number,
  timing: FlowTiming = DEFAULT_FLOW_TIMING,
): number {
  if (index < timing.targetIndex) {
    return startFrame + index * timing.nodeLightStagger;
  }
  if (index === timing.targetIndex) {
    return flowWakeFrame(startFrame, timing);
  }
  return (
    flowWakeFrame(startFrame, timing) + (index - timing.targetIndex) * timing.downstreamLightDelay
  );
}

/**
 * A node's lit intensity at `frame`, 0 (parked/dim) → 1 (fully green), clamped
 * both ends. The target (agent) node uses the faster `agentFillRamp` so its
 * dim → green FILL snaps at the wake (the emotional beat); every other node
 * uses `nodeLightRamp`. Pure — a plain `interpolate`, no hooks.
 */
export function nodeLitProgress(
  index: number,
  frame: number,
  startFrame: number,
  timing: FlowTiming = DEFAULT_FLOW_TIMING,
): number {
  const litFrame = flowNodeLitFrame(index, startFrame, timing);
  const ramp = index === timing.targetIndex ? timing.agentFillRamp : timing.nodeLightRamp;
  return interpolate(frame, [litFrame, litFrame + ramp], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * The token's progress along the source → target connector at `frame`: 0 before
 * (and at) the travel start, easing on rails (§3.4 inOut cubic — the token
 * "arcs" cleanly, never bouncy) to exactly 1 at the wake frame, clamped there.
 * Drives the token's position and the green connector fill left → right behind
 * it. Pure — no hooks.
 */
export function tokenTravelProgress(
  frame: number,
  startFrame: number,
  timing: FlowTiming = DEFAULT_FLOW_TIMING,
): number {
  return interpolate(
    frame,
    [flowTravelStartFrame(startFrame, timing), flowWakeFrame(startFrame, timing)],
    [0, 1],
    { easing: EASE_INOUT_CUBIC, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
}

// ── Render constants (pixels; the pure math above is resolution-independent). ──

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 300;
const NODE_W = 150;
const NODE_H = 64;
const NODE_RADIUS = 12;
const PAD_X_FRACTION = 0.12; // inset the first/last node centers from the box edges
const CENTERLINE_Y_FRACTION = 0.42; // nodes sit above center; labels hang below
const TOKEN_SIZE = 18;
const TOKEN_TRAIL_COUNT = 4;
const TOKEN_TRAIL_STEP = 0.06; // arc-progress spacing between trail ghosts
const MAX_NODE_GLOW = 26; // px box-shadow blur on a fully-woken node
const MAX_FILL_WASH = 0.14; // peak opacity of the translucent verified wash a lit node fills with

/** Center x (px) of node `index` in a `count`-node row spanning `width`. */
function nodeCenterX(index: number, count: number, width: number): number {
  const padX = width * PAD_X_FRACTION;
  if (count <= 1) return width / 2;
  return padX + ((width - 2 * padX) * index) / (count - 1);
}

export interface FlowDiagramProps {
  /** Ordered node labels along the flow. Defaults to the S16 chain. */
  nodes?: readonly string[];
  /** Scene-local frame the diagram begins (the node-light sequence starts here). Default 0. */
  startFrame?: number;
  /** Index the green token departs FROM. Must be lit before travel. Default 1 (`verified`). */
  sourceIndex?: number;
  /** Index the token arrives AT and wakes. Must equal sourceIndex + 1. Default 2 (`agent`). */
  targetIndex?: number;
  /** Drawing box width (px). */
  width?: number;
  /** Drawing box height (px). */
  height?: number;
}

/**
 * The Remotion wrapper: owns `useCurrentFrame()` / `useVideoConfig()`, builds a
 * `FlowTiming` from the props, and renders the nodes, connectors, and traveling
 * token from the pure helpers above. Renders a positioned `div` (like
 * `DeliveryFlow`) so a scene can drop it into a split layout.
 */
export function FlowDiagram({
  nodes = FLOW_NODES_DEFAULT,
  startFrame = 0,
  sourceIndex = SOURCE_INDEX_DEFAULT,
  targetIndex = TARGET_INDEX_DEFAULT,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: FlowDiagramProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const timing: FlowTiming = { ...DEFAULT_FLOW_TIMING, sourceIndex, targetIndex };
  const count = nodes.length;
  const centerY = height * CENTERLINE_Y_FRACTION;

  const wakeFrame = flowWakeFrame(startFrame, timing);
  const travelStart = flowTravelStartFrame(startFrame, timing);
  const travel = tokenTravelProgress(frame, startFrame, timing);

  const sourceX = nodeCenterX(sourceIndex, count, width);
  const targetX = nodeCenterX(targetIndex, count, width);
  // The token rides the connector while traveling, then hands off to the agent's
  // own fill+pop at the wake (so it never lingers past its arrival).
  const tokenVisible = frame >= travelStart && frame < wakeFrame;
  const tokenX = sourceX + (targetX - sourceX) * travel;

  return (
    <div style={{ position: "relative", width, height }}>
      {/* Connectors — one per adjacent node pair. The source→target connector
          fills green left→right behind the traveling token; the others fill with
          their downstream node's lit progress. */}
      {Array.from({ length: Math.max(count - 1, 0) }, (_, i) => {
        const x1 = nodeCenterX(i, count, width);
        const x2 = nodeCenterX(i + 1, count, width);
        const span = x2 - x1;
        const fill = i === sourceIndex ? travel : nodeLitProgress(i + 1, frame, startFrame, timing);
        return (
          <div key={`conn-${i}`}>
            {/* Base hairline. */}
            <div
              style={{
                position: "absolute",
                left: x1,
                top: centerY,
                width: span,
                height: 2,
                background: colors.termBorder,
                transform: "translateY(-50%)",
              }}
            />
            {/* Green fill drawing in from the upstream end. */}
            <div
              style={{
                position: "absolute",
                left: x1,
                top: centerY,
                width: span * fill,
                height: 2,
                background: colors.verified,
                opacity: fill,
                transform: "translateY(-50%)",
                boxShadow: fill > 0 ? `0 0 6px ${colors.wire}` : "none",
              }}
            />
          </div>
        );
      })}

      {/* Nodes. */}
      {nodes.map((label, i) => {
        const cx = nodeCenterX(i, count, width);
        const lit = nodeLitProgress(i, frame, startFrame, timing);
        const isTarget = i === targetIndex;

        // The target (agent) reuses the film's ONE "land" motion at the wake:
        // the §3.4 overshoot pop + the decaying verified-glow (VerifiedBadge's
        // shared helpers), so it "springs to life" identically to every land.
        const wakeRelative = frame - wakeFrame;
        const woke = isTarget && frame >= wakeFrame;
        const scale = woke ? badgePopScale(wakeRelative, fps) : 1;
        const wakeGlow = woke ? badgeGlowOpacity(wakeRelative) : 0;

        const border = interpolateColors(lit, [0, 1], [colors.termBorder, colors.verified]);
        const labelColor = interpolateColors(lit, [0, 1], [colors.termDim, colors.termFg]);
        // Steady lit-glow, plus the extra bloom on the agent at the wake.
        const glowBlur = MAX_NODE_GLOW * Math.max(lit * 0.55, wakeGlow);

        return (
          <div
            key={`node-${i}`}
            style={{
              position: "absolute",
              left: cx,
              top: centerY,
              width: NODE_W,
              height: NODE_H,
              transform: `translate(-50%, -50%) scale(${scale})`,
            }}
          >
            <div
              style={{
                position: "relative",
                width: "100%",
                height: "100%",
                borderRadius: NODE_RADIUS,
                border: `1.5px solid ${border}`,
                background: colors.termBg2,
                boxShadow:
                  glowBlur > 0.5 ? `0 0 ${Math.round(glowBlur)}px ${colors.verifiedGlow}` : "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {/* Translucent verified wash — the "fill" (grows 0 → MAX_FILL_WASH as
                  the node lights). Kept token-pure (colors.verified over termBg2),
                  no raw surface hex. */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: NODE_RADIUS,
                  background: colors.verified,
                  opacity: lit * MAX_FILL_WASH,
                }}
              />
              <span
                style={{
                  ...type.badge,
                  fontFamily: mono,
                  color: labelColor,
                  position: "relative",
                }}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}

      {/* The traveling green token — the verified signal physically crossing the
          connector into the agent. A comet head + a short wire-tinted trail. */}
      {tokenVisible ? (
        <>
          {Array.from({ length: TOKEN_TRAIL_COUNT }, (_, k) => {
            const sampleT = Math.max(travel - (k + 1) * TOKEN_TRAIL_STEP, 0);
            const gx = sourceX + (targetX - sourceX) * sampleT;
            const falloff = 1 - (k + 1) / (TOKEN_TRAIL_COUNT + 1);
            return (
              <div
                key={`trail-${k}`}
                style={{
                  position: "absolute",
                  left: gx,
                  top: centerY,
                  width: TOKEN_SIZE * falloff,
                  height: TOKEN_SIZE * falloff,
                  borderRadius: "50%",
                  background: colors.wire,
                  opacity: falloff * 0.6,
                  transform: "translate(-50%, -50%)",
                }}
              />
            );
          })}
          <div
            style={{
              position: "absolute",
              left: tokenX,
              top: centerY,
              width: TOKEN_SIZE,
              height: TOKEN_SIZE,
              borderRadius: "50%",
              background: colors.verified,
              transform: "translate(-50%, -50%)",
              boxShadow: `0 0 16px 6px ${colors.verifiedGlow}`,
            }}
          />
        </>
      ) : null}
    </div>
  );
}
