// MCPTranscript — chat-style MCP tool-call transcript on `mcp.webhook.co` (brief
// §4.10 / Act III S14–S15).
//
// `{ blocks: { kind: 'call' | 'response'; text }[]; startFrame }`. A "call" block
// is the agent's own tool call (`triggers.create`, `triggers.wait`) — rendered
// plain mono, flush left, and typed 1 char/frame exactly like every other
// terminal/product string in the film (reuses `TypedLine`'s own
// `revealedCharCount`/`isCursorOn` pure helpers, so the typing math is identical,
// not re-derived). A "response" block is the returned result — rendered as an
// indented bubble that slides in from the right on the brief's §3.4 "on rails"
// motion (eased inOut cubic, never bouncy) once the preceding block has finished
// revealing.
//
// Blocks are a strictly ordered, gapped sequence: block 0 begins at `startFrame`;
// every later block begins `MCP_TRANSCRIPT_GAP_FRAMES` after the previous one
// fully reveals (brief S14→S15 — `triggers.create`'s response settles before
// `triggers.wait` begins typing). A block that hasn't reached its own start frame
// is omitted entirely (a transcript appends messages, it doesn't reserve blank
// space for ones still to come); once a block has started it stays in the
// rendered list forever after — the transcript keeps its own history, exactly
// like S14/S15 keep `triggers.create`'s call+response on screen while
// `triggers.wait` types below it.
//
// Split into pure timing/reveal functions (`blockDurationFrames`,
// `blockStartFrames`, `responseSlideProgress`, `computeRenderBlocks` — all plain
// functions of `frame`, no Remotion hooks, so the whole reveal timeline is
// directly unit-testable) + a hook-free `MCPTranscriptView` + a thin
// `MCPTranscript` wrapper that owns `useCurrentFrame()` — the same adapter split
// used by `TypedLine`/`TerminalIsland`/`EventRow` in this package.
//
// All motion is a pure function of `useCurrentFrame()` — no `Math.random`,
// `Date.now`, or CSS transitions/keyframes (repo rule + brief determinism).

import { Easing, interpolate, useCurrentFrame } from "remotion";

import { mono } from "../fonts";
import { colors, motion, type } from "../tokens";
import { isCursorOn, revealedCharCount } from "./TypedLine";

/** The two block kinds a transcript entry can be (brief §4.10). */
export type MCPTranscriptBlockKind = "call" | "response";

export interface MCPTranscriptBlock {
  kind: MCPTranscriptBlockKind;
  /** The real MCP call/result string (rendered byte-for-byte). */
  text: string;
}

const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);

/**
 * Frames held after a block fully reveals before the next one begins — mirrors
 * the brief's S14 gap between the call finishing typing (f1150) and the
 * response beginning its slide (f1160). Keeps the transcript a strictly
 * ordered, non-overlapping sequence.
 */
export const MCP_TRANSCRIPT_GAP_FRAMES = 10;

/**
 * Frames a "response" block takes to slide in from the right and settle. Reuses
 * the brief §3.4 "cross-surface travel / wipes" rails duration (eased inOut
 * cubic, never bouncy) rather than hardcoding the brief's scene-specific S14
 * timing (1160→1190, 30 frames) — a response bubble sliding into a chat
 * transcript is the same "on rails" motion vocabulary as a panel wipe, just at
 * component scale, so it takes the same general-purpose constant every other
 * rails move in the film uses.
 */
export const MCP_TRANSCRIPT_SLIDE_FRAMES = motion.railsDurationFrames;

/** Horizontal distance (px) a response bubble travels in from the right as it settles. */
const RESPONSE_SLIDE_DISTANCE = 56;
/** Left indent (px) a settled response bubble sits at — "indented" per brief §4.10. */
const RESPONSE_INDENT = 40;
const RESPONSE_BUBBLE_RADIUS = 8;

/**
 * Frames a single block takes to fully reveal. A "call" block types 1 char/frame
 * at the film's fixed 30fps (brief §3.4's literal typing formula — the same rate
 * `TypedLine`'s `revealedCharCount` uses); a "response" block reveals
 * positionally (it slides in, brief S14), so its duration is fixed regardless of
 * text length. A pure function of the block + rate, no Remotion hooks.
 */
export function blockDurationFrames(
  block: MCPTranscriptBlock,
  cps: number = motion.typingCps,
  fps = 30,
): number {
  if (block.kind === "response") {
    return MCP_TRANSCRIPT_SLIDE_FRAMES;
  }
  return Math.ceil((block.text.length * fps) / cps);
}

/**
 * Every block's absolute start frame, in order: block 0 begins at `startFrame`;
 * each subsequent block begins exactly `MCP_TRANSCRIPT_GAP_FRAMES` after the
 * previous one fully reveals. A chat-style transcript is a strictly ordered,
 * gapped sequence — two blocks never reveal simultaneously, and array order
 * always matches time order.
 */
export function blockStartFrames(
  blocks: readonly MCPTranscriptBlock[],
  startFrame: number,
): number[] {
  const starts: number[] = [];
  let cursor = startFrame;
  for (const block of blocks) {
    starts.push(cursor);
    cursor += blockDurationFrames(block) + MCP_TRANSCRIPT_GAP_FRAMES;
  }
  return starts;
}

/**
 * A "response" block's slide-in progress, 0 (off-screen right, transparent) → 1
 * (settled at its indent, fully opaque) — brief §3.4's eased inOut cubic, "on
 * rails", never bouncy. A pure function of the block-relative frame.
 */
export function responseSlideProgress(relativeFrame: number): number {
  return interpolate(relativeFrame, [0, MCP_TRANSCRIPT_SLIDE_FRAMES], [0, 1], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export type MCPTranscriptRenderBlock =
  | {
      kind: "call";
      text: string;
      /** Already-sliced substring of `text` to render this frame. */
      visibleText: string;
      /** Whether this call has finished typing (gates the blinking cursor). */
      typedDone: boolean;
      /** Current cursor blink phase (ignored once `typedDone`). */
      cursorOn: boolean;
    }
  | {
      kind: "response";
      text: string;
      /** Entrance opacity, 0→1, tied to the slide progress. */
      opacity: number;
      /** Current horizontal offset (px); 0 once fully settled. */
      translateX: number;
    };

/**
 * Pure per-frame render state for every block that has already reached its own
 * start frame, in order — the function the `useCurrentFrame()`-owning wrapper
 * calls, and the one this component's tests exercise directly (no Remotion
 * composition context needed). A block before its own start frame is omitted
 * entirely; once included, a block never disappears again (the transcript
 * keeps its history).
 */
export function computeRenderBlocks(
  blocks: readonly MCPTranscriptBlock[],
  startFrame: number,
  frame: number,
): MCPTranscriptRenderBlock[] {
  const starts = blockStartFrames(blocks, startFrame);
  const rendered: MCPTranscriptRenderBlock[] = [];

  blocks.forEach((block, i) => {
    // `starts` has exactly one entry per block (see `blockStartFrames`), so `starts[i]` is
    // always defined here — noUncheckedIndexedAccess can't see that invariant.
    const blockStart = starts[i]!;
    if (frame < blockStart) return;

    if (block.kind === "call") {
      const revealed = revealedCharCount(frame, blockStart, block.text.length);
      rendered.push({
        kind: "call",
        text: block.text,
        visibleText: block.text.slice(0, revealed),
        typedDone: revealed >= block.text.length,
        cursorOn: isCursorOn(frame),
      });
    } else {
      const relativeFrame = frame - blockStart;
      const progress = responseSlideProgress(relativeFrame);
      rendered.push({
        kind: "response",
        text: block.text,
        opacity: progress,
        translateX: (1 - progress) * RESPONSE_SLIDE_DISTANCE,
      });
    }
  });

  return rendered;
}

export interface MCPTranscriptViewProps {
  /** Already-computed render state, in time order — see `computeRenderBlocks`. */
  blocks: MCPTranscriptRenderBlock[];
}

/**
 * Pure presentational half: takes the already-computed per-block render state as
 * plain props (no `useCurrentFrame()`), so it renders like any other React
 * component and is trivially unit-testable in jsdom.
 */
export function MCPTranscriptView({ blocks }: MCPTranscriptViewProps) {
  return (
    <div
      data-testid="mcp-transcript"
      style={{ display: "flex", flexDirection: "column", gap: 16, fontFamily: mono }}
    >
      {blocks.map((block, i) =>
        block.kind === "call" ? (
          <div
            key={i}
            data-testid="mcp-transcript-call"
            style={{ ...type.terminalBody, color: colors.termFg, whiteSpace: "pre" }}
          >
            <span>{block.visibleText}</span>
            {!block.typedDone ? (
              <span aria-hidden style={{ opacity: block.cursorOn ? 1 : 0 }}>
                ▉
              </span>
            ) : null}
          </div>
        ) : (
          <div
            key={i}
            data-testid="mcp-transcript-response"
            style={{
              ...type.terminalBody,
              alignSelf: "flex-start",
              marginLeft: RESPONSE_INDENT,
              padding: "10px 16px",
              borderRadius: RESPONSE_BUBBLE_RADIUS,
              border: `1px solid ${colors.termBorder}`,
              backgroundColor: colors.termBg2,
              color: colors.termFg,
              whiteSpace: "pre",
              opacity: block.opacity,
              transform: `translateX(${block.translateX}px)`,
            }}
          >
            {block.text}
          </div>
        ),
      )}
    </div>
  );
}

export interface MCPTranscriptProps {
  blocks: MCPTranscriptBlock[];
  /** Absolute frame the first block begins typing/sliding in. */
  startFrame: number;
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`, computes every started
 * block's render state via `computeRenderBlocks`, and hands the plain array
 * down to `MCPTranscriptView`.
 */
export function MCPTranscript({ blocks, startFrame }: MCPTranscriptProps) {
  const frame = useCurrentFrame();
  const renderBlocks = computeRenderBlocks(blocks, startFrame, frame);

  return <MCPTranscriptView blocks={renderBlocks} />;
}
