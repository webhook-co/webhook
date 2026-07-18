import { describe, expect, it } from "vitest";

import { CAPTIONS, EVENTS_TABLE } from "./captions";

// These strings render on screen and must stay byte-for-byte with brief §6.1.
// A drifted caption is a shipped typo, so the data itself is the unit under test.
describe("CAPTIONS data integrity", () => {
  it("opens with the S1 hero line exactly", () => {
    const s1 = CAPTIONS.find((c) => c.scene === "S1" && c.kind === "hero");
    expect(s1?.text).toBe("Send a webhook.");
  });

  it("carries the signature line verbatim in the S19 close", () => {
    const sig = CAPTIONS.find((c) => c.scene === "S19" && c.kind === "hero");
    expect(sig?.text).toBe("Send a webhook. Watch it land.");
  });

  it("states the only real number as an exact '142 providers' claim", () => {
    const s6 = CAPTIONS.find((c) => c.scene === "S6" && c.kind === "hero");
    expect(s6?.text).toBe("Verified at the edge. 142 providers.");
  });

  it("names the failure wedge as RAW_BODY_MODIFIED", () => {
    const s7 = CAPTIONS.find((c) => c.scene === "S7" && c.kind === "code");
    expect(s7?.text).toBe("RAW_BODY_MODIFIED");
  });

  it("holds the hero headline verbatim", () => {
    const s18 = CAPTIONS.find((c) => c.scene === "S18" && c.kind === "hero");
    expect(s18?.text).toBe("The webhook platform built for the agent era.");
  });

  it("contains zero exclamation points across every caption (brand voice)", () => {
    expect(CAPTIONS.every((c) => !c.text.includes("!"))).toBe(true);
  });

  it("keeps frame windows ordered (from < to) for every caption", () => {
    expect(CAPTIONS.every((c) => c.from < c.to)).toBe(true);
  });

  it("has the events table header exactly as the brief", () => {
    expect(EVENTS_TABLE[0]).toBe("RECEIVED                  PROVIDER  VERIFIED       ID");
  });

  it("renders the linear/verified row byte-for-byte", () => {
    expect(EVENTS_TABLE[1]).toBe("2026-07-12T14:02:11.840Z  linear    verified       0197f0c1-...");
  });

  it("renders the gitlab row with the amber authenticated state", () => {
    expect(EVENTS_TABLE[3]).toBe("2026-07-12T14:03:02.902Z  gitlab    authenticated  0197f0c3-...");
  });
});
