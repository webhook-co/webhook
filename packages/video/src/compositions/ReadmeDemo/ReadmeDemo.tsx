// ReadmeDemo — the looping terminal demo for the public README + social shares.
//
// This is NOT the promo film. It is a short, silent, looping asset whose only
// job is the README's one job: make a skeptical senior dev think "this is real"
// in one glance. So the REAL recording fills the frame and the overlay merely
// points at it — two captions and one highlight, nothing more.
//
// The footage (public/terminal.mp4) is an unedited `wbhk listen` session against
// a real endpoint: unsigned POSTs land `unverified`, GitHub-HMAC-signed POSTs
// land `github verified`. Nothing on screen is staged, so nothing here may
// claim more than the frames show.
//
// A GIF has no audio, so every word must be on screen — the captions are the
// narration, not decoration.

import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";

import { mono } from "../../promo/fonts";
import { colors, radii, shadows } from "../../promo/tokens";
import {
  CAPTIONS,
  captionOpacity,
  CHROME_HEIGHT,
  READMEDEMO_WIDTH,
  TERMINAL_HEIGHT,
  TERMINAL_WIDTH,
} from "./beats";
import { DemoLockup, WindowChromeView } from "./components";

const WINDOW_X = (READMEDEMO_WIDTH - TERMINAL_WIDTH) / 2;
const WINDOW_Y = 112;

export function ReadmeDemo() {
  const frame = useCurrentFrame();

  // NO intro fade, deliberately. This asset loops forever in a README, so any
  // fade-in on the chrome becomes a flash of empty frame every 12s at the loop
  // seam. The window and brand are simply always present; only the terminal
  // content cycles, which reads as the command being run again.

  return (
    // A STATIC backdrop, deliberately. The promo film's drifting dot lattice
    // changes every frame, which defeats GIF delta-compression — it cost ~40%
    // of the file size for a texture that is invisible at README width.
    <AbsoluteFill
      style={{
        backgroundColor: colors.termBg,
        backgroundImage:
          "radial-gradient(120% 80% at 50% 0%, rgba(63,178,127,0.06) 0%, rgba(11,13,16,0) 60%)",
      }}
    >
      {/* Header rail: brand left, the one CTA right. */}
      <div
        style={{
          position: "absolute",
          left: WINDOW_X,
          right: WINDOW_X,
          top: 58,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <DemoLockup />
        <span style={{ fontFamily: mono, fontSize: 16, color: colors.termDim }}>
          npx @webhook-co/cli
        </span>
      </div>

      {/* The desktop window: chrome + the real recording. */}
      <div
        style={{
          position: "absolute",
          left: WINDOW_X,
          top: WINDOW_Y,
          width: TERMINAL_WIDTH,
          borderRadius: radii.terminal,
          overflow: "hidden",
          border: `1px solid ${colors.termBorder}`,
          boxShadow: shadows.terminal,
        }}
      >
        <WindowChromeView title="wbhk listen" />
        {/* Just the recording. The terminal's own colouring already marks each
            row `verified` (green) / `unverified` (amber) — that's real CLI
            output, so no overlay is needed or wanted on top of it; the caption
            below names what the column means. */}
        <OffthreadVideo
          src={staticFile("terminal.mp4")}
          style={{
            width: TERMINAL_WIDTH,
            height: TERMINAL_HEIGHT,
            display: "block",
            backgroundColor: colors.termBg,
          }}
          muted
        />
      </div>

      {/* The narration. One caption at a time, cross-faded. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: WINDOW_Y + CHROME_HEIGHT + TERMINAL_HEIGHT + 46,
          height: 40,
          textAlign: "center",
        }}
      >
        {CAPTIONS.map((caption) => (
          <span
            key={caption.text}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              fontFamily: mono,
              fontSize: 26,
              color: colors.termFg,
              opacity: captionOpacity(frame, caption),
            }}
          >
            {caption.text}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
}
