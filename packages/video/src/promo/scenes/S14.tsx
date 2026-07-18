// S14 · frames 1110–1230 · 0:37–0:41 — the agent subscribes (brief §5 S14).
//
// The dark <TerminalIsland header="mcp.webhook.co"> hosts an <MCPTranscript>:
// the agent's `triggers.create` call types 1 char/frame, then the returned
// subscription id slides in from the right as a result bubble. These are the
// real shipped MCP strings (`triggers.create`, a truncated `sub_…` id) — the
// only on-screen copy in the scene (brief §4.10 / Appendix C: real strings only).
//
// Timing note (mirrors the S11 precedent): the transcript types at the film's
// fixed 1 char/frame (real typing speed, brand voice) rather than stretching to
// the brief's nominal caption window — `triggers.create` (15 chars) types local
// f6→f21 and the response settles by local f52, then holds into the S15 park.
// The transcript is anchored so its create+response rows sit in the SAME place
// across the S14→S15 cut (S15 appends `triggers.wait` beneath them). Authored in
// scene-local frames.

import { AbsoluteFill, useVideoConfig } from "remotion";

import { MCPTranscript } from "../components/MCPTranscript";
import type { MCPTranscriptBlock } from "../components/MCPTranscript";
import { DotsBackground } from "../components/DotsBackground";
import { TerminalIsland } from "../components/TerminalIsland";
import { titleSafe, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S14Props {
  format: Format;
}

// The real MCP strings (brief §4.10 / §5 S14). The subscription id is truncated
// (brief's sanctioned `sub_…` form); its digits reuse the real event-id prefix
// so no identifier characters are invented.
const BLOCKS: MCPTranscriptBlock[] = [
  { kind: "call", text: "triggers.create" },
  { kind: "response", text: "sub_0197f0c1..." },
];

const TRANSCRIPT_START = 6; // `triggers.create` begins typing local f6 (comp f1116)

export function S14({ format }: S14Props) {
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const islandWidth = Math.min(1200 * s, W - 2 * m);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <TerminalIsland header="mcp.webhook.co" width={islandWidth} enterAtFrame={0}>
        {/* Reserve height so the transcript grows downward within a stable body
            (the create+response rows keep their position across the S14→S15 cut). */}
        <div style={{ minHeight: 180 * s }}>
          <MCPTranscript blocks={BLOCKS} startFrame={TRANSCRIPT_START} />
        </div>
      </TerminalIsland>
    </AbsoluteFill>
  );
}
