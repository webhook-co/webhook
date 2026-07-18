import { describe, expect, it } from "vitest";

import {
  BEAT_FRAMES,
  CATCH_FRAMES,
  chipDepartFrame,
  DIVERT_PROGRESS,
  DIVERT_TRAVEL_FRAMES,
  FAIL_STOP_PROGRESS,
  RETREAT_FRAMES,
  RETREAT_PROGRESS,
  RETRY_ADVANCE_FRAMES,
  RETRY_LAND_OFFSET,
  RETRY_PAUSE_FRAMES,
  TRAVEL_FRAMES,
  binBlinkOpacity,
  deadLetterCatchFrame,
  deadLetterChipProgress,
  normalChipProgress,
  retryChipPhase,
  retryChipProgress,
} from "./DeliveryFlow";

// chipDepartFrame is the FIFO beat: departure order must strictly follow queue order, on an
// even beat, so the queue reads as ordered — never re-ordered or bunched.
describe("chipDepartFrame", () => {
  it("departs chip 0 exactly at startFrame", () => {
    expect(chipDepartFrame(0, 4)).toBe(4);
  });

  it("spaces departures by the default beat", () => {
    expect(chipDepartFrame(1, 4)).toBe(4 + BEAT_FRAMES);
    expect(chipDepartFrame(4, 4)).toBe(4 + 4 * BEAT_FRAMES);
  });

  it("honors a custom beat", () => {
    expect(chipDepartFrame(3, 0, 10)).toBe(30);
  });

  it("produces strictly increasing departures across the queue (FIFO order)", () => {
    let prev = chipDepartFrame(0, 4);
    for (let i = 1; i < 5; i++) {
      const departure = chipDepartFrame(i, 4);
      expect(departure).toBeGreaterThan(prev);
      prev = departure;
    }
  });
});

// normalChipProgress is a plain chip's queue->endpoint travel: rests at 0 before departure,
// reaches 1 exactly at TRAVEL_FRAMES, and never overshoots past 1 (no bounce on a clean land).
describe("normalChipProgress", () => {
  it("is 0 before and at the moment of departure", () => {
    expect(normalChipProgress(-5)).toBe(0);
    expect(normalChipProgress(0)).toBe(0);
  });

  it("reaches exactly 1 at TRAVEL_FRAMES and clamps there afterward", () => {
    expect(normalChipProgress(TRAVEL_FRAMES)).toBe(1);
    expect(normalChipProgress(TRAVEL_FRAMES + 50)).toBe(1);
  });

  it("is strictly between 0 and 1 partway through travel", () => {
    const mid = normalChipProgress(TRAVEL_FRAMES / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("is monotonically non-decreasing across the travel window", () => {
    let prev = -Infinity;
    for (let f = -2; f <= TRAVEL_FRAMES + 2; f++) {
      const p = normalChipProgress(f);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

// retryChipPhase is the discrete state machine behind the bounce-back-and-retry beat; every
// downstream position/visibility decision depends on drawing the phase boundary at the right
// frame, so each transition edge is asserted exactly.
describe("retryChipPhase", () => {
  const RETREAT_END = TRAVEL_FRAMES + RETREAT_FRAMES;
  const PAUSE_END = RETREAT_END + RETRY_PAUSE_FRAMES;

  it("is queued before departure", () => {
    expect(retryChipPhase(-1)).toBe("queued");
  });

  it("is advancing from departure up to (not including) TRAVEL_FRAMES", () => {
    expect(retryChipPhase(0)).toBe("advancing");
    expect(retryChipPhase(TRAVEL_FRAMES - 1)).toBe("advancing");
  });

  it("switches to retreating exactly at TRAVEL_FRAMES", () => {
    expect(retryChipPhase(TRAVEL_FRAMES)).toBe("retreating");
    expect(retryChipPhase(RETREAT_END - 1)).toBe("retreating");
  });

  it("switches to paused exactly when the retreat window ends", () => {
    expect(retryChipPhase(RETREAT_END)).toBe("paused");
    expect(retryChipPhase(PAUSE_END - 1)).toBe("paused");
  });

  it("switches to retrying exactly when the pause window ends", () => {
    expect(retryChipPhase(PAUSE_END)).toBe("retrying");
    expect(retryChipPhase(RETRY_LAND_OFFSET - 1)).toBe("retrying");
  });

  it("lands exactly at RETRY_LAND_OFFSET and stays landed", () => {
    expect(retryChipPhase(RETRY_LAND_OFFSET)).toBe("landed");
    expect(retryChipPhase(RETRY_LAND_OFFSET + 1000)).toBe("landed");
  });
});

// retryChipProgress is the actual "fails and bounces back, then re-advances — never
// disappears" beat: it must climb toward the endpoint, genuinely retreat (a real bounce, not
// a plateau), hold, then climb all the way to landing. It must never drop back to 0 (the chip
// is never sent back to the start of the queue) and never exceed 1 before it truly lands.
describe("retryChipProgress", () => {
  it("starts at 0 and climbs during the first advance", () => {
    expect(retryChipProgress(0)).toBe(0);
    expect(retryChipProgress(TRAVEL_FRAMES)).toBeCloseTo(FAIL_STOP_PROGRESS, 5);
  });

  it("genuinely retreats: progress at the end of the retreat window is lower than the fail point", () => {
    const atFail = retryChipProgress(TRAVEL_FRAMES);
    const afterRetreat = retryChipProgress(TRAVEL_FRAMES + RETREAT_FRAMES);
    expect(afterRetreat).toBeCloseTo(RETREAT_PROGRESS, 5);
    expect(afterRetreat).toBeLessThan(atFail);
  });

  it("holds flat at RETREAT_PROGRESS through the whole pause window", () => {
    const pauseStart = TRAVEL_FRAMES + RETREAT_FRAMES;
    const pauseEnd = pauseStart + RETRY_PAUSE_FRAMES;
    for (let f = pauseStart; f < pauseEnd; f++) {
      expect(retryChipProgress(f)).toBe(RETREAT_PROGRESS);
    }
  });

  it("re-advances from RETREAT_PROGRESS up to exactly 1 by RETRY_LAND_OFFSET", () => {
    const retryStart = TRAVEL_FRAMES + RETREAT_FRAMES + RETRY_PAUSE_FRAMES;
    expect(retryChipProgress(retryStart)).toBeCloseTo(RETREAT_PROGRESS, 5);
    expect(retryChipProgress(RETRY_LAND_OFFSET)).toBe(1);
  });

  it("never regresses to 0 once it has left the queue (it bounces back, it never disappears)", () => {
    // f=0 is the departure instant itself (progress 0 by definition); every frame after
    // that — through the fail, the retreat, the pause, and the retry — must stay above 0.
    for (let f = 1; f <= RETRY_LAND_OFFSET + RETRY_ADVANCE_FRAMES; f++) {
      expect(retryChipProgress(f)).toBeGreaterThan(0);
    }
  });

  it("never exceeds 1", () => {
    for (let f = 0; f <= RETRY_LAND_OFFSET + 100; f++) {
      expect(retryChipProgress(f)).toBeLessThanOrEqual(1);
    }
  });

  it("stays landed at 1 for any frame after RETRY_LAND_OFFSET", () => {
    expect(retryChipProgress(RETRY_LAND_OFFSET + 500)).toBe(1);
  });
});

// deadLetterChipProgress is the "caught, not delivered" beat: it must never reach the
// endpoint's progress of 1 (it diverts before then), and its bin-catch must run 0->1.
describe("deadLetterChipProgress", () => {
  it("starts on the track at progress 0, uncaught", () => {
    const { along, caught } = deadLetterChipProgress(-1);
    expect(along).toBe(0);
    expect(caught).toBe(0);
  });

  it("reaches exactly DIVERT_PROGRESS along the track and never goes further", () => {
    expect(deadLetterChipProgress(DIVERT_TRAVEL_FRAMES).along).toBeCloseTo(DIVERT_PROGRESS, 5);
    expect(deadLetterChipProgress(DIVERT_TRAVEL_FRAMES + 1000).along).toBeCloseTo(
      DIVERT_PROGRESS,
      5,
    );
  });

  it("never reaches the endpoint's progress of 1 — it is caught, not delivered", () => {
    for (let f = -5; f <= DIVERT_TRAVEL_FRAMES + CATCH_FRAMES + 200; f++) {
      expect(deadLetterChipProgress(f).along).toBeLessThan(1);
    }
  });

  it("is uncaught until the divert point, then catches fully by CATCH_FRAMES later", () => {
    expect(deadLetterChipProgress(DIVERT_TRAVEL_FRAMES).caught).toBe(0);
    expect(deadLetterChipProgress(DIVERT_TRAVEL_FRAMES + CATCH_FRAMES).caught).toBe(1);
    expect(deadLetterChipProgress(DIVERT_TRAVEL_FRAMES + CATCH_FRAMES + 100).caught).toBe(1);
  });
});

describe("deadLetterCatchFrame", () => {
  it("is the divert travel plus the catch window, after departure", () => {
    expect(deadLetterCatchFrame(52)).toBe(52 + DIVERT_TRAVEL_FRAMES + CATCH_FRAMES);
  });
});

// binBlinkOpacity is the "blinks once" pulse: silent until the catch, a single decaying flash
// after — never a sustained glow (which would read as an alarm, not a confirming catch).
describe("binBlinkOpacity", () => {
  it("is 0 before the catch frame", () => {
    expect(binBlinkOpacity(99, 100)).toBe(0);
  });

  it("peaks at exactly 1 on the catch frame", () => {
    expect(binBlinkOpacity(100, 100)).toBe(1);
  });

  it("decays monotonically after the catch", () => {
    let prev = binBlinkOpacity(100, 100);
    for (let f = 101; f <= 130; f++) {
      const opacity = binBlinkOpacity(f, 100);
      expect(opacity).toBeLessThanOrEqual(prev);
      prev = opacity;
    }
  });

  it("settles at 0 well after the decay window and never re-blinks", () => {
    expect(binBlinkOpacity(1000, 100)).toBe(0);
  });
});
