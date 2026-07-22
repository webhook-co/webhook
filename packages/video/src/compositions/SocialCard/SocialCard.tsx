// SocialCard — the GitHub repository social-preview image (Settings → General).
//
// A static 1280×640 still, rendered from this composition so it shares the
// canonical brand Mark and the Geist fonts with everything else rather than a
// one-off HTML file. GitHub has no API for the upload, so the OUTPUT of this
// (a PNG) is handed to the founder to upload by hand; this file just produces it.
//
// Design = the "doesn't expire" wedge (research Card C): the differentiator
// stated as a contrast, which names the competitor category without naming a
// competitor — and so stays clear of the repo's public-content hygiene rule. A
// dark card by choice: it reads as a distinct object on both light and dark
// client surfaces, where a near-white card dissolves into a light timeline.
//
// Legibility floor: at Discord's ~400px render (scale 0.31), the 92px headline
// lands at ~22px and the 40px subline at ~12px — both readable; the 30px footer
// is decorative only. See the social-card research for the arithmetic.

import type { ReactElement } from "react";
import { AbsoluteFill } from "remotion";

import { Mark } from "@webhook-co/ui";

import { inter, mono } from "../../promo/fonts";

export const SOCIALCARD_WIDTH = 1280;
export const SOCIALCARD_HEIGHT = 640;

// The headline, rendered as three literals whose concatenation IS
// SOCIAL_HEADLINE (the test pins this, so the displayed text can't drift from
// the constant the copy-hygiene tests check). The break falls after "URL"; the
// accent lands on "expire" — two independent positions, hence three parts.
const HEAD_LINE1 = "Your webhook URL ";
const HEAD_BEFORE_ACCENT = "doesn't ";
const HEAD_ACCENT = "expire";
const HEAD_AFTER = ".";

/** Wedge-first, contrast-stated, no slogan, no competitor. */
export const SOCIAL_HEADLINE = (HEAD_LINE1 + HEAD_BEFORE_ACCENT + HEAD_ACCENT + HEAD_AFTER).replace(
  /\s+/g,
  " ",
);
export const SOCIAL_SUBLINE = "Free, permanent, signature-verified. Replays to localhost.";

const INK = "#f8fafc";
const MUTED = "#94a3b8";
const DIM = "#64748b";
const ACCENT = "#3FB27F"; // colors.verified — the one accent
const BG = "#0b0f14";
const MARGIN = 88;

export function SocialCard(): ReactElement {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: BG,
        backgroundImage: `radial-gradient(120% 80% at 50% 0%, rgba(63,178,127,0.07) 0%, rgba(11,15,20,0) 58%)`,
        color: INK,
        fontFamily: inter,
      }}
    >
      {/* Brand lockup, top-left. The Mark inherits currentColor → white here. */}
      <div
        style={{
          position: "absolute",
          top: 56,
          left: MARGIN,
          display: "flex",
          alignItems: "center",
          gap: 16,
          color: "#e2e8f0",
        }}
      >
        <Mark size={44} aria-label="webhook.co" />
        <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>
          webhook<span style={{ fontWeight: 400, color: DIM }}>.co</span>
        </span>
      </div>

      {/* The wedge. Break after "URL"; the accent lands on "expire". The three
          literals concatenate to SOCIAL_HEADLINE (pinned by the test), so the
          displayed text can't drift from the copy-hygiene constant. */}
      <div
        style={{
          position: "absolute",
          left: MARGIN,
          top: 200,
          width: 1104,
          fontSize: 92,
          fontWeight: 600,
          lineHeight: 1.04,
          letterSpacing: "-0.04em",
        }}
      >
        {HEAD_LINE1}
        <br />
        {HEAD_BEFORE_ACCENT}
        <span style={{ color: ACCENT }}>{HEAD_ACCENT}</span>
        {HEAD_AFTER}
      </div>

      {/* Everything else the product is, in one line, above the legibility floor. */}
      <div
        style={{
          position: "absolute",
          left: MARGIN,
          top: 430,
          width: 1104,
          fontSize: 40,
          fontWeight: 450,
          lineHeight: 1.3,
          letterSpacing: "-0.015em",
          color: MUTED,
        }}
      >
        {SOCIAL_SUBLINE}
      </div>

      {/* Footer chip + licence — decorative at feed size, legible up close. */}
      <div
        style={{
          position: "absolute",
          left: MARGIN,
          bottom: 56,
          display: "flex",
          alignItems: "center",
          gap: 22,
          fontFamily: mono,
          fontSize: 30,
        }}
      >
        <span
          style={{
            padding: "8px 22px",
            borderRadius: 999,
            border: "1.5px solid #24303c",
            color: "#cbd5e1",
          }}
        >
          wbhk.my
        </span>
        <span style={{ color: DIM }}>Apache-2.0</span>
      </div>
    </AbsoluteFill>
  );
}
