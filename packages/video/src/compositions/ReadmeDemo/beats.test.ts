import { describe, expect, it } from "vitest";

import {
  CALLOUT,
  CAPTION_FADE_FRAMES,
  CAPTIONS,
  calloutOpacity,
  captionOpacity,
  READMEDEMO_DURATION_IN_FRAMES,
  READMEDEMO_FPS,
  VERDICT_BAND,
} from "./beats";

describe("ReadmeDemo timing constants", () => {
  it("matches the 12s / 25fps terminal source it overlays", () => {
    // The captured terminal mp4 is 300 frames at 25fps. If the composition and
    // the footage disagree, the overlay drifts off the rows it points at.
    expect(READMEDEMO_FPS).toBe(25);
    expect(READMEDEMO_DURATION_IN_FRAMES).toBe(300);
  });

  it("keeps every caption inside the composition", () => {
    for (const c of CAPTIONS) {
      expect(c.from).toBeGreaterThanOrEqual(0);
      expect(c.from + c.durationInFrames).toBeLessThanOrEqual(READMEDEMO_DURATION_IN_FRAMES);
    }
  });

  it("never shows two captions at once", () => {
    for (let frame = 0; frame < READMEDEMO_DURATION_IN_FRAMES; frame += 1) {
      const visible = CAPTIONS.filter((c) => captionOpacity(frame, c) > 0);
      expect(visible.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("captionOpacity", () => {
  const caption = { from: 100, durationInFrames: 100, text: "x" } as const;

  it("is 0 before the caption starts", () => {
    expect(captionOpacity(99, caption)).toBe(0);
    expect(captionOpacity(0, caption)).toBe(0);
  });

  it("is 0 once the caption has ended", () => {
    expect(captionOpacity(200, caption)).toBe(0);
    expect(captionOpacity(299, caption)).toBe(0);
  });

  it("reaches full opacity in the middle", () => {
    expect(captionOpacity(150, caption)).toBe(1);
  });

  it("fades in over CAPTION_FADE_FRAMES", () => {
    expect(captionOpacity(100, caption)).toBe(0);
    expect(captionOpacity(100 + CAPTION_FADE_FRAMES, caption)).toBe(1);
    const mid = captionOpacity(100 + CAPTION_FADE_FRAMES / 2, caption);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("fades out over CAPTION_FADE_FRAMES", () => {
    expect(captionOpacity(200 - CAPTION_FADE_FRAMES, caption)).toBe(1);
    const mid = captionOpacity(200 - CAPTION_FADE_FRAMES / 2, caption);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("calloutOpacity", () => {
  it("is 0 before the callout window", () => {
    expect(calloutOpacity(CALLOUT.from - 1)).toBe(0);
  });

  it("is fully on inside the window", () => {
    expect(calloutOpacity(CALLOUT.from + CALLOUT.durationInFrames / 2)).toBe(1);
  });

  it("is 0 after the window", () => {
    expect(calloutOpacity(CALLOUT.from + CALLOUT.durationInFrames)).toBe(0);
  });

  it("never exceeds 1 at any frame", () => {
    for (let frame = 0; frame < READMEDEMO_DURATION_IN_FRAMES; frame += 1) {
      const o = calloutOpacity(frame);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
  });
});

describe("VERDICT_BAND", () => {
  // Measured off the real recording: the amber `unverified` ink spans x 243..381
  // and the green `verified` ink spans x 315..425 inside the 1060px-wide
  // terminal. The TUI is space-separated, not fixed-column, so the band has to
  // cover the union of both — a per-word box would sit off one of them.
  it("covers both the amber and green verdict ink", () => {
    expect(VERDICT_BAND.x).toBeLessThanOrEqual(243);
    expect(VERDICT_BAND.x + VERDICT_BAND.width).toBeGreaterThanOrEqual(425);
  });

  it("stays inside the terminal viewport", () => {
    expect(VERDICT_BAND.x).toBeGreaterThanOrEqual(0);
    expect(VERDICT_BAND.x + VERDICT_BAND.width).toBeLessThanOrEqual(1060);
    expect(VERDICT_BAND.y + VERDICT_BAND.height).toBeLessThanOrEqual(430);
  });

  // The row list GROWS as events land (ink spans y 100..175 early, y 70..295 by
  // the end), so the band is sized to the column, not to the rows present at
  // any one frame. It must therefore clear the "wbhk listen · N events" header
  // above (ends ~y62) and the "↑/↓ move · r replay" footer below (starts ~y320)
  // — an earlier version bled into the header and read as a rendering artifact.
  it("clears the header above and the footer below", () => {
    expect(VERDICT_BAND.y).toBeGreaterThanOrEqual(64);
    expect(VERDICT_BAND.y + VERDICT_BAND.height).toBeLessThanOrEqual(318);
  });

  it("hugs the verdict ink rather than floating wide of it", () => {
    // Measured ink: x 244..425. Keep the padding tight on both sides.
    expect(244 - VERDICT_BAND.x).toBeLessThanOrEqual(16);
    expect(VERDICT_BAND.x + VERDICT_BAND.width - 425).toBeLessThanOrEqual(16);
  });
});
