import { describe, expect, it } from "vitest";

import { getPacketLandFrame } from "./Packet";

// getPacketLandFrame is the one piece of real logic in Packet (the rest is pure
// frame->pixel rendering, verified by render). It decides the frame a scene
// should fire its own <RingPulse> + thock — getting it wrong desyncs the
// visual land from the audio land.
describe("getPacketLandFrame", () => {
  it("defaults to the packet's arrival frame when no override is given", () => {
    expect(getPacketLandFrame(100, 44)).toBe(144);
  });

  it("matches the brief's S2->S3 beat: arrives f144, lands f150", () => {
    // brief §5 S2: startFrame 100, durationFrames 44 -> arrives f144;
    // §5 S3: the THOCK (land) is explicitly 6 frames later, at f150.
    expect(getPacketLandFrame(100, 44, 150)).toBe(150);
  });

  it("clamps an onLandFrame earlier than arrival up to the arrival frame", () => {
    // land can never precede the packet actually reaching its target.
    expect(getPacketLandFrame(100, 44, 120)).toBe(144);
  });

  it("clamps an onLandFrame equal to arrival to that same frame", () => {
    expect(getPacketLandFrame(810, 30, 840)).toBe(840);
  });
});
