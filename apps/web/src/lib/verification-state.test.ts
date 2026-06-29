import { describe, expect, it } from "vitest";

import { verificationStatePill } from "./verification-state";

describe("verificationStatePill", () => {
  it("maps each state to a tone + label; only `failed` is danger", () => {
    expect(verificationStatePill("verified")).toEqual({ tone: "ok", label: "Verified" });
    expect(verificationStatePill("failed")).toEqual({ tone: "danger", label: "Failed" });
    expect(verificationStatePill("unattempted")).toEqual({
      tone: "neutral",
      label: "Not verified",
    });
  });

  it("falls back to the `verified` boolean when the state is absent (no silent downgrade)", () => {
    // An absent state on a verified event still reads green (not a neutral downgrade).
    expect(verificationStatePill(undefined, true)).toEqual({ tone: "ok", label: "Verified" });
    // An absent state on an unverified event can't tell failed from unattempted → neutral.
    expect(verificationStatePill(undefined, false)).toEqual({
      tone: "neutral",
      label: "Not verified",
    });
    expect(verificationStatePill(undefined)).toEqual({ tone: "neutral", label: "Not verified" });
  });
});
