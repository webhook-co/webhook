import { describe, expect, it } from "vitest";

import {
  CAPTION_FADE_FRAMES,
  CAPTIONS,
  captionOpacity,
  READMEDEMO_DURATION_IN_FRAMES,
  READMEDEMO_FPS,
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
