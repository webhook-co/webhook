// S12 · frames 900–1020 · 0:30–0:34 — same event, every surface (brief §5 S12).
//
// ACT III opens dark again. The SAME event (linear · verified · 0197f0c1-…) is
// shown four ways in quick succession — mcp · cli · api · web — each surface
// leading for ~30 frames, with MCP weighted slightly heavier as the lead
// surface. <SurfaceTabs> owns the tab chrome + the green underline that sweeps
// to whichever surface is active; this scene supplies each surface's own real
// content in a single swap region and keeps the shared id string fixed/legible
// beneath as the continuity anchor (brief §5 S12: "the shared id string stays
// fixed/legible through each swap"). Overline: "same event. every surface."
//
// Accent discipline (global Act III rule): green (colors.verified) is the ONLY
// saturated accent here — the `verified` state, the SurfaceTabs underline. No
// red/amber. Authored in scene-local frames.

import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DashboardCard } from "../components/DashboardCard";
import { DotsBackground } from "../components/DotsBackground";
import { SurfaceTabs } from "../components/SurfaceTabs";
import { inter, mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S12Props {
  format: Format;
}

const OVERLINE = CAPTIONS.find((c) => c.scene === "S12" && c.kind === "overline")?.text ?? "";
// The listen line — the real S4 `wbhk listen` output, byte-for-byte (brief §5 S12: "CLI = the listen line").
const LISTEN_LINE = CAPTIONS.find((c) => c.scene === "S4" && c.kind === "output")?.text ?? "";

const TABS = ["mcp", "cli", "api", "web"] as const;

// The same event as every other surface in the film (S3/S4/S6), byte-for-byte.
const EVENT = {
  provider: "linear",
  received: "2026-07-12T14:02:11.840Z",
  id: "0197f0c1-...", // the continuity anchor — matches EVENTS_TABLE / DashboardCard truncation
  state: "verified",
} as const;

// The canonical events route (real: `GET /v1/events`).
const API_PATH = "api.webhook.co/v1/events";

// Per-surface lead windows (scene-local). MCP leads and is weighted heavier
// (~38f) as the lead surface; the rest run ~28–30f each (brief §5 S12).
const SURFACE_STARTS = [4, 42, 72, 100] as const;
const CONTENT_FADE = 8;

export function S12({ format }: S12Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  // Whichever surface has most-recently become active leads now.
  let active = 0;
  for (let i = 0; i < SURFACE_STARTS.length; i++) {
    if (frame >= SURFACE_STARTS[i]!) active = i;
  }
  const activeStart = SURFACE_STARTS[active]!;

  // The active surface's content fades in on its swap (rails-ish, quiet).
  const contentOpacity = interpolate(frame, [activeStart, activeStart + CONTENT_FADE], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const contentShift = interpolate(contentOpacity, [0, 1], [10 * s, 0]);

  const contentMaxWidth = Math.min(1500 * s, W - 2 * m);
  const bodyFont = type.terminalBody.fontSize * s;

  const renderSurface = () => {
    switch (active) {
      case 0: // mcp — a tool result: the event's fields in a bordered result bubble.
        return (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 20 * s,
              padding: `${16 * s}px ${24 * s}px`,
              borderRadius: 10,
              border: `1px solid ${colors.termBorder}`,
              background: colors.termBg2,
              fontFamily: mono,
              fontSize: bodyFont,
            }}
          >
            <span style={{ color: colors.termDim }}>{EVENT.provider}</span>
            <span style={{ color: colors.verified, fontWeight: 600 }}>{EVENT.state}</span>
          </div>
        );
      case 1: // cli — the live listen line, byte-for-byte.
        return (
          <div
            style={{
              maxWidth: contentMaxWidth,
              fontFamily: mono,
              fontSize: 24 * s,
              color: colors.termFg,
              whiteSpace: "pre",
              overflow: "hidden",
            }}
          >
            <span style={{ color: colors.termDim }}>{"$ wbhk listen\n"}</span>
            {LISTEN_LINE}
          </div>
        );
      case 2: // api — the canonical events route in a dark URL pill.
        return (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 14 * s,
              padding: `${12 * s}px ${22 * s}px`,
              borderRadius: 999,
              border: `1px solid ${colors.termBorder}`,
              background: colors.termBg2,
            }}
          >
            {/* HTTP method stays uppercase (not a brand name) — matches S2's POST chip. */}
            <span
              style={{
                ...type.badge,
                fontSize: type.badge.fontSize * s,
                textTransform: "none",
                fontFamily: mono,
                color: colors.verified,
              }}
            >
              GET
            </span>
            <span style={{ fontFamily: mono, fontSize: bodyFont, color: colors.termFg }}>
              {API_PATH}
            </span>
          </div>
        );
      default: // web — the light dashboard card.
        return (
          <DashboardCard
            provider={EVENT.provider}
            received={EVENT.received}
            id={EVENT.id}
            state={EVENT.state}
            startFrame={activeStart}
          />
        );
    }
  };

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 40 * s,
        }}
      >
        {/* Overline — sentence-case, dim (brief §5 S12). */}
        <span
          style={{
            fontFamily: inter,
            fontSize: type.caption.fontSize * s,
            fontWeight: 400,
            color: colors.termDim,
          }}
        >
          {OVERLINE}
        </span>

        {/* The four surface tabs + the sweeping green underline. */}
        <SurfaceTabs
          tabs={TABS}
          activeIndex={active}
          startFrame={activeStart}
          format={format}
          scale={s}
        />

        {/* Swap region — a fixed-height stage so the anchor below never jumps. */}
        <div
          style={{
            height: 230 * s,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: contentOpacity,
            transform: `translateY(${contentShift}px)`,
          }}
        >
          {renderSurface()}
        </div>

        {/* Continuity anchor — the shared id, fixed + legible through every swap. */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12 * s,
            fontFamily: mono,
            fontSize: type.trustFooter.fontSize * s,
          }}
        >
          <span style={{ color: colors.termDim }}>id</span>
          <span style={{ color: colors.termFg }}>{EVENT.id}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
