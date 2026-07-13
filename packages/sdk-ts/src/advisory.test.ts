import { describe, expect, it, vi } from "vitest";

import { makeAdvisoryReporter, parseAdvisory } from "./advisory.js";

describe("parseAdvisory", () => {
  it("parses an update advisory", () => {
    expect(parseAdvisory("update-available; current=0.2.0; latest=0.3.0", null)).toEqual({
      deprecated: false,
      current: "0.2.0",
      latest: "0.3.0",
      message:
        "webhook.co: a newer SDK is available (0.2.0 → 0.3.0). Upgrade with: npm install @webhook-co/sdk@latest",
    });
  });

  it("marks a deprecation louder than a mere update", () => {
    const advisory = parseAdvisory("deprecated; current=0.1.0; latest=0.3.0", "true");
    expect(advisory!.deprecated).toBe(true);
    expect(advisory!.message).toContain("no longer supported");
  });

  it("returns null when there is no advisory (the overwhelmingly common case)", () => {
    expect(parseAdvisory(null, null)).toBeNull();
  });

  // The server is not the SDK's parser. A malformed or hostile header must never throw inside someone's
  // request path — the worst it can do is say nothing.
  it("returns null for a malformed header instead of throwing", () => {
    for (const bad of ["", "garbage", "update-available", "update-available; current=; latest="]) {
      expect(() => parseAdvisory(bad, null)).not.toThrow();
      expect(parseAdvisory(bad, null)).toBeNull();
    }
  });
});

describe("makeAdvisoryReporter", () => {
  it("reports an advisory exactly ONCE, however many requests you make", () => {
    const onAdvisory = vi.fn();
    const report = makeAdvisoryReporter({ onAdvisory });
    const header = "update-available; current=0.2.0; latest=0.3.0";
    for (let i = 0; i < 5; i++) report(header, null);
    expect(onAdvisory).toHaveBeenCalledTimes(1); // a per-request nag is a bug, not a feature
  });

  it("hands the caller the parsed advisory, not a string to re-parse", () => {
    const onAdvisory = vi.fn();
    makeAdvisoryReporter({ onAdvisory })("update-available; current=0.2.0; latest=0.3.0", null);
    expect(onAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({ current: "0.2.0", latest: "0.3.0", deprecated: false }),
    );
  });

  it("falls back to a ONE-TIME stderr line when no handler is given", () => {
    const warn = vi.fn();
    const report = makeAdvisoryReporter({ warn });
    report("update-available; current=0.2.0; latest=0.3.0", null);
    report("update-available; current=0.2.0; latest=0.3.0", null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("0.2.0 → 0.3.0");
  });

  // A library writing to stderr inside someone's production app is rude at best. It must be silenceable
  // without also silencing a caller's own handler.
  it("is fully silent when muted", () => {
    const warn = vi.fn();
    const report = makeAdvisoryReporter({ warn, silent: true });
    report("deprecated; current=0.1.0; latest=0.3.0", "true");
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers the caller's handler over stderr (never both)", () => {
    const onAdvisory = vi.fn();
    const warn = vi.fn();
    makeAdvisoryReporter({ onAdvisory, warn })(
      "update-available; current=0.2.0; latest=0.3.0",
      null,
    );
    expect(onAdvisory).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  // The advisory rides on responses in the caller's request path. If their handler throws, that is THEIR
  // bug — but it must not become a failed API call.
  it("never lets a throwing handler break the request", () => {
    const onAdvisory = vi.fn(() => {
      throw new Error("boom");
    });
    const report = makeAdvisoryReporter({ onAdvisory });
    expect(() => report("update-available; current=0.2.0; latest=0.3.0", null)).not.toThrow();
  });

  it("does nothing at all when there is no advisory header", () => {
    const onAdvisory = vi.fn();
    const warn = vi.fn();
    makeAdvisoryReporter({ onAdvisory, warn })(null, null);
    expect(onAdvisory).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
